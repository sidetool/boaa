import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { migrateDatabase } from '../db/migrate.js';
import { registerDocumentTextRoutes } from '../routes/books/document-text-routes.js';
import { applyHostedLibraryBatch } from './hosted-library-management-service.js';
import {
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from './id-v2-migration/postgres-integration-harness.js';

const harness = await startPostgresIntegrationHarness();
const config = { defaultUserId: 'owner' } as ServerConfig;

function observe(pool: pg.Pool, afterQuery?: (sql: string) => Promise<void>) {
  const queries: string[] = [];
  const observed = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          queries.push(sql);
          const result = await client.query(sql, values);
          await afterQuery?.(sql);
          return result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as pg.Pool;
  return { pool: observed, queries };
}

async function fixture(pool: pg.Pool, count = 2) {
  await migrateDatabase(pool);
  await pool.query(
    "insert into users (id, email, display_name) values ('owner','owner@example.com','Owner'),('other','other@example.com','Other')",
  );
  await pool.query(
    "insert into book_objects (id,user_id,raw_text_hash,storage_key,file_name,content_type,size_bytes) values ('source','owner','source','source','source.pdf','application/pdf',100)",
  );
  await pool.query(
    `insert into library_books (id,user_id,object_id,title,source_file_name,source_encoding,format,normalized_text_hash,total_chapters,total_characters,total_paragraphs)
    select 'book-' || n, 'owner','source','Book','source.pdf','binary','pdf','hash-' || n,1,0,0 from generate_series(1,$1::integer) n`,
    [count],
  );
  await pool.query('update library_books set metadata_revision = 1');
}

(harness ? describe : describe.skip)('hosted bulk writes with isolated PostgreSQL', () => {
  afterAll(async () => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);

  test('writes 512 text blocks in one insert and preserves replacement, ownership, and rollback', async () => {
    await withPostgresSchema(harness!, 'document_text_batch', async (pool) => {
      await fixture(pool);
      const observed = observe(pool);
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.principal = { userId: 'owner', role: 'admin', authMethod: 'legacy-token' };
      });
      await registerDocumentTextRoutes(app, observed.pool, config);
      const page = (bookId: string, id: string, count: number) => ({
        revision: {
          id,
          bookId,
          pageIndex: 0,
          pageHash: 'same-page-hash',
          source: 'pdf_native',
          engine: 'pdfjs',
          engineVersion: '1',
          status: 'ready',
          qualityScore: 0.5,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        },
        blocks: Array.from({ length: count }, (_, order) => ({
          id: `${id}-${order}`,
          revisionId: id,
          bookId,
          pageIndex: 0,
          order,
          role: 'paragraph',
          text: `Text ${order}`,
          normalizedText: 'forged',
          quads: [],
          direction: 'ltr',
        })),
      });
      const put = (payload: ReturnType<typeof page>) =>
        app.inject({ method: 'PUT', url: `/api/books/${payload.revision.bookId}/document-text/pages/0`, payload });
      const snapshot = async () => ({
        revisions: (await pool.query('select * from document_text_revisions order by id')).rows,
        blocks: (await pool.query('select * from document_text_blocks order by id')).rows,
      });
      try {
        const payload = page('book-1', 'revision-one', 512);
        expect((await put(payload)).statusCode).toBe(200);
        expect(observed.queries.filter((sql) => sql.includes('insert into document_text_blocks'))).toHaveLength(1);
        const blocks = (
          await pool.query('select block_order, normalized_text from document_text_blocks order by block_order')
        ).rows;
        expect(blocks).toHaveLength(512);
        expect(blocks[511]).toEqual({ block_order: 511, normalized_text: 'text 511' });
        const beforeCollision = await snapshot();
        expect((await put(page('book-2', 'revision-one', 1))).statusCode).toBe(404);
        expect(await snapshot()).toEqual(beforeCollision);
        // A different text revision stales the previous one; saving that old ID
        // again must replace changed text/quality even with the same page hash.
        expect((await put(page('book-1', 'revision-two', 1))).statusCode).toBe(200);
        payload.revision.qualityScore = 0.9;
        payload.blocks[0].text = 'Changed OCR text';
        expect((await put(payload)).statusCode).toBe(200);
        expect(
          (
            await pool.query(
              "select status,quality_score::float8 as quality from document_text_revisions where id='revision-one'",
            )
          ).rows,
        ).toEqual([{ status: 'ready', quality: 0.9 }]);
        expect((await pool.query("select text from document_text_blocks where id='revision-one-0'")).rows).toEqual([
          { text: 'Changed OCR text' },
        ]);
        const other = page('book-2', 'other-revision', 1);
        expect((await put(other)).statusCode).toBe(200);
        const beforeFailure = await snapshot();
        const rejected = page('book-1', 'failed-revision', 2);
        rejected.blocks[1].id = other.blocks[0].id; // SQL PK failure after the stale/delete work.
        expect((await put(rejected)).statusCode).toBe(500);
        expect(await snapshot()).toEqual(beforeFailure);
        const empty = page('book-1', 'revision-one', 0);
        expect((await put(empty)).statusCode).toBe(200);
        expect((await pool.query("select * from document_text_blocks where revision_id='revision-one'")).rows).toEqual(
          [],
        );
      } finally {
        await app.close();
      }
    });
  }, 30_000);

  test('checks a shelf once for 100 items, preserving item order, conflicts, savepoints, and no-op events', async () => {
    await withPostgresSchema(harness!, 'library_batch', async (pool) => {
      await fixture(pool, 100);
      await pool.query(
        "insert into shelves (id,user_id,name,sort_order) values ('shelf','owner','Shelf',0),('foreign','other','Other',0)",
      );
      const observed = observe(pool);
      const targets = Array.from({ length: 100 }, (_, i) => ({ bookId: `book-${i + 1}`, expectedRevision: 1 }));
      const receipt = await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'add_to_shelf', shelfId: 'shelf' },
        targets,
        '100',
      );
      expect(receipt.results.map((item) => item.bookId)).toEqual(targets.map((item) => item.bookId));
      expect(receipt.results.every((item) => item.status === 'applied')).toBe(true);
      expect(observed.queries.filter((sql) => sql.includes('select id from shelves'))).toHaveLength(1);
      expect(observed.queries.filter((sql) => sql.includes('as shelf_exists'))).toHaveLength(0);
      expect(observed.queries.filter((sql) => sql === 'savepoint library_batch_item')).toHaveLength(100);
      expect(observed.queries).toHaveLength(506); // 5 per item plus 6 transaction/receipt/common queries.
      expect((await pool.query('select count(*)::integer as count from sync_events')).rows[0].count).toBe(100);
      observed.queries.length = 0;
      await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'add_to_shelf', shelfId: 'shelf' },
        [targets[0]],
        'one-noop',
      );
      expect(observed.queries.filter((sql) => sql.includes('select id from shelves'))).toHaveLength(1);
      expect((await pool.query('select count(*)::integer as count from sync_events')).rows[0].count).toBe(100);
      await pool.query("insert into shelves (id,user_id,name,sort_order) values ('single','owner','Single',1)");
      observed.queries.length = 0;
      await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'add_to_shelf', shelfId: 'single' },
        [targets[0]],
        'one',
      );
      expect(observed.queries).toHaveLength(11);
      const partial = await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'set_favorite', favorite: true },
        [targets[0], targets[0], { bookId: 'missing' }, targets[1]],
        'duplicates',
      );
      expect(partial.results.map((item) => [item.bookId, item.status, item.reason])).toEqual([
        ['book-1', 'applied', undefined],
        ['book-1', 'failed', 'metadata_revision_changed'],
        ['missing', 'failed', 'book_not_found'],
        ['book-2', 'applied', undefined],
      ]);
      const denied = await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'add_to_shelf', shelfId: 'foreign' },
        [{ bookId: 'book-3' }],
        'foreign',
      );
      expect(denied.results).toMatchObject([{ status: 'failed', reason: 'Shelf was not found' }]);
      // A database error must roll back just the item, including its metadata,
      // and still allow the following item and receipt to commit.
      await pool.query("alter table sync_events add constraint reject_four check (book_id <> 'book-4') not valid");
      const failed = await applyHostedLibraryBatch(
        observed.pool,
        config,
        { kind: 'set_favorite', favorite: true },
        [{ bookId: 'book-4' }, { bookId: 'book-5' }],
        'partial-sql',
      );
      expect(failed.results.map((item) => item.status)).toEqual(['failed', 'applied']);
      expect(
        (
          await pool.query(
            "select favorite,metadata_revision::integer as revision from library_books where id='book-4'",
          )
        ).rows,
      ).toEqual([{ favorite: false, revision: 1 }]);
    });
  }, 30_000);

  test('serializes simultaneous same-key retries and rolls back mutations if receipt storage fails', async () => {
    await withPostgresSchema(harness!, 'library_retry', async (pool) => {
      await fixture(pool);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let receiptReads = 0;
      const observed = observe(pool, async (sql) => {
        if (sql.includes('select * from library_operation_receipts') && ++receiptReads === 1) await gate;
      });
      const command = { kind: 'set_favorite', favorite: true } as const;
      const targets = [{ bookId: 'book-1', expectedRevision: 1 }];
      const first = applyHostedLibraryBatch(observed.pool, config, command, targets, 'same-key');
      await vi.waitFor(() => expect(receiptReads).toBe(1));
      const second = applyHostedLibraryBatch(observed.pool, config, command, targets, 'same-key');
      try {
        await vi.waitFor(() =>
          expect(observed.queries.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2),
        );
        expect(receiptReads).toBe(1);
      } finally {
        release();
      }
      const [one, two] = await Promise.all([first, second]);
      expect(two).toEqual(one);
      expect(
        (await pool.query('select count(*)::integer as count from library_operation_receipts')).rows[0].count,
      ).toBe(1);
      expect((await pool.query('select count(*)::integer as count from sync_events')).rows[0].count).toBe(1);
      expect(
        (await pool.query("select metadata_revision::integer as revision from library_books where id='book-1'")).rows[0]
          .revision,
      ).toBe(2);
      const other = await applyHostedLibraryBatch(
        pool,
        { defaultUserId: 'other' } as ServerConfig,
        command,
        targets,
        'same-key',
      );
      expect(other.id).not.toBe(one.id);
      expect(other.results[0]).toMatchObject({ status: 'failed', reason: 'book_not_found' });
      await pool.query(
        "alter table library_operation_receipts add constraint reject_receipt check (idempotency_key <> 'fail')",
      );
      await expect(applyHostedLibraryBatch(pool, config, command, [{ bookId: 'book-2' }], 'fail')).rejects.toThrow();
      expect(
        (
          await pool.query(
            "select favorite, metadata_revision::integer as revision from library_books where id='book-2'",
          )
        ).rows,
      ).toEqual([{ favorite: false, revision: 1 }]);
      expect((await pool.query('select count(*)::integer as count from sync_events')).rows[0].count).toBe(1);
    });
  }, 30_000);
});
