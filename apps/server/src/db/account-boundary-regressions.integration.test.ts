import { SelfHostAuthService, PostgresSelfHostAuthStore } from '../services/self-host-auth-service.js';
import { registerSelfHostAuthRoutes } from '../routes/auth.js';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RequestPrincipal } from '@boaa/contracts';
import { persistentId128, integrityHash } from '@boaa/text-core/hash';
import { SYNC_CONTRACT_V2 } from '@boaa/reader-core/sync-contract';
import { migrateDatabase } from './migrate.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { testConfig } from '../routes/books/books-route-test-harness.js';
import { registerReaderPersonalizationRoutes } from '../routes/books/personalization-routes.js';
import { registerSyncPushRoute } from '../routes/sync/push-route.js';
import { exportHostedBackup, restoreHostedBackup } from '../services/hosted-backup-service.js';
import { parseHostedBackupArchive } from '../services/hosted-backup-archive.js';
import { processImportJob } from '../services/import-service.js';
import { insertChapterBatch } from '../services/import/stage-content.js';

// This suite must never attach to an operator-provided database.
for (const key of Object.keys(process.env))
  if (key.endsWith('_TEST_DATABASE_URL') || key === 'POSTGRES_TEST_URL') delete process.env[key];
const harness = await startPostgresIntegrationHarness();
if (harness?.source === 'environment') throw new Error('isolated database required');
const suite = harness ? describe : describe.skip;
suite('account write boundaries', { timeout: 60_000 }, () => {
  afterAll(async () => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
  test('reading events and payload-only sync cannot cross owners, even for admin', async () => {
    await withPostgresSchema(harness!, 'account_writes', async (pool) => {
      await migrateDatabase(pool);
      await pool.query("insert into users(id,display_name) values('a','A'),('b','B')");
      await pool.query(
        "insert into library_books(id,user_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs) values('book_a','a','A','fixture.txt','hash',0,0,0),('book_b','b','B','fixture.txt','hash',0,0,0)",
      );
      await pool.query(
        "insert into voice_profiles(id,book_id,role,provider_id,provider_voice_id,label) values('profile_b','book_b','narrator','mock','mock','B private')",
      );
      const app = Fastify();
      let principal: RequestPrincipal = { userId: 'a', role: 'member', authMethod: 'session', sessionContext: 'a' };
      app.addHook('onRequest', async (request) => {
        request.principal = principal;
      });
      await registerReaderPersonalizationRoutes(app, pool, testConfig());
      registerSyncPushRoute(app, pool, testConfig());
      try {
        const body = {
          id: 'session_a',
          operationId: 'operation_a',
          deviceId: 'device_a',
          bookId: 'book_b',
          mode: 'reading',
          startedAt: '2026-01-01T00:00:00Z',
          endedAt: '2026-01-01T00:01:00Z',
          activeSeconds: 60,
        };
        const denied = await app.inject({ method: 'POST', url: '/api/reading-sessions', payload: body });
        expect(denied.statusCode).toBe(404);
        const allowed = await app.inject({
          method: 'POST',
          url: '/api/reading-sessions',
          payload: { ...body, bookId: 'book_a' },
        });
        expect(allowed.statusCode).toBe(200);
        await expect(
          pool.query(
            "insert into reading_session_events(id,user_id,book_id,device_id,mode,started_at,ended_at,active_seconds,operation_id) values('bad','a','book_b','d','reading',now(),now(),1,'bad')",
          ),
        ).rejects.toMatchObject({ code: '23503' });
        // Defense for pre-existing inconsistent rows, independent of the new FK.
        await pool.query('alter table reading_session_events drop constraint reading_session_events_book_owner_fk');
        await pool.query(
          "insert into reading_session_events(id,user_id,book_id,device_id,mode,started_at,ended_at,active_seconds,operation_id) values('old_bad','a','book_b','d','reading',now(),now(),1,'old_bad')",
        );
        const exported = await exportHostedBackup(pool, { ...testConfig(), defaultUserId: 'b' });
        const chunks: Buffer[] = [];
        for (const reader = exported.readable.getReader(); ;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(Buffer.from(next.value));
        }
        await exported.completion;
        const archive = await parseHostedBackupArchive(Buffer.concat(chunks));
        expect(archive.tables.get('reading_session_events')).toEqual([]);
        principal = { ...principal, role: 'admin' };
        const foreignEvents = [
          ['voice_profiles_updated', { bookId: 'book_b', voiceProfiles: [] }],
          ['voice_casting_updated', { bookId: 'book_b' }],
          ['character_graph_updated', { bookId: 'book_b', characters: [], relations: [], mode: 'replace' }],
          ['chapter_segments_updated', { bookId: 'book_b', segments: [] }],
          ['user_correction_created', { correction: { bookId: 'book_b' } }],
          ['user_correction_deleted', { bookId: 'book_b', id: 'correction_b' }],
          ['bookmark_created', { bookmark: { novelId: 'book_b' } }],
          ['highlight_created', { highlight: { novelId: 'book_b' } }],
          ['note_created', { note: { novelId: 'book_b' } }],
          ['document_annotation_updated', { annotation: { bookId: 'book_b' } }],
          ['document_text_order_override_updated', { orderOverride: { bookId: 'book_b' } }],
          ['shelf_membership_added', { membership: { bookId: 'book_b' } }],
        ];
        for (const [index, [type, payload]] of foreignEvents.entries())
          for (const novelId of [undefined, 'book_a']) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/sync/events',
              payload: {
                ...SYNC_CONTRACT_V2,
                events: [
                  {
                    ...SYNC_CONTRACT_V2,
                    id: persistentId128('sync_event', [String(index), String(novelId)]),
                    deviceId: 'a',
                    type,
                    payload,
                    novelId,
                    createdAt: '2099-01-01T00:00:00.000Z',
                  },
                ],
              },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().accepted).toBe(0);
            expect(response.json().rejected).toHaveLength(1);
          }
        const owned = await app.inject({
          method: 'POST',
          url: '/api/sync/events',
          payload: {
            ...SYNC_CONTRACT_V2,
            events: [
              {
                ...SYNC_CONTRACT_V2,
                id: persistentId128('sync_event', ['owned']),
                deviceId: 'a',
                type: 'voice_profiles_updated',
                payload: { bookId: 'book_a', voiceProfiles: [] },
                createdAt: '2099-01-01T00:00:00.000Z',
              },
            ],
          },
        });
        expect(owned.json().accepted).toBe(1);
        expect((await pool.query("select book_id from sync_events where user_id='a'")).rows).toEqual([
          { book_id: 'book_a' },
        ]);
        expect((await pool.query("select id from voice_profiles where book_id='book_b'")).rows).toEqual([
          { id: 'profile_b' },
        ]);
      } finally {
        await app.close();
      }
    });
  });
  test('a collision at the final namespaced import ID cannot replace another owner content', async () => {
    await withPostgresSchema(harness!, 'import_final_owner', async (pool) => {
      await migrateDatabase(pool);
      await pool.query("insert into users(id,display_name) values('a','A'),('b','B')");
      const target = persistentId128('hosted_book', ['b', 'same-client']);
      await pool.query(
        "insert into library_books(id,user_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs) values($1,'a','Original A','original.txt','hash',1,4,1)",
        [target],
      );
      await pool.query(
        "insert into chapters(id,book_id,chapter_index,title,text_hash,raw_start_offset,raw_end_offset,character_count,paragraph_count) values('original_chapter',$1,0,'Original chapter','hash',0,4,4,1)",
        [target],
      );
      const root = await mkdtemp(path.join(tmpdir(), 'boaa-owner-regression-'));
      try {
        const bytes = Buffer.from('Chapter 1\n\nMEMBER B REPLACEMENT CONTENT');
        await mkdir(path.join(root, 'uploads', 'upload_b'), { recursive: true });
        const chunk = path.join(root, 'uploads', 'upload_b', '00000000.part');
        await writeFile(chunk, bytes);
        await pool.query(
          "insert into upload_sessions(id,user_id,file_name,size_bytes,content_type,encoding,status,total_chunks,client_book_id) values('upload_b','b','member.txt',$1,'text/plain','utf-8','queued',1,'same-client')",
          [bytes.length],
        );
        await pool.query(
          "insert into upload_chunks(upload_id,chunk_index,size_bytes,storage_path) values('upload_b',0,$1,$2)",
          [bytes.length, chunk],
        );
        await pool.query(
          "insert into import_jobs(id,user_id,upload_id,status) values('import_b','b','upload_b','queued')",
        );
        await expect(
          processImportJob(
            pool,
            {
              ...testConfig(),
              defaultUserId: 'a',
              dataDir: root,
              objectStorageDir: path.join(root, 'objects'),
              storageCapacityPath: '',
            },
            'import_b',
            'upload_b',
          ),
        ).rejects.toThrow('import_target_not_found');
        expect((await pool.query("select status,book_id from import_jobs where id='import_b'")).rows[0]).toEqual({
          status: 'failed',
          book_id: null,
        });
        expect((await pool.query('select user_id,title from library_books where id=$1', [target])).rows[0]).toEqual({
          user_id: 'a',
          title: 'Original A',
        });
        expect((await pool.query('select id,title from chapters where book_id=$1', [target])).rows).toEqual([
          { id: 'original_chapter', title: 'Original chapter' },
        ]);
        const client = await pool.connect();
        try {
          await expect(
            insertChapterBatch(client, [
              {
                id: 'original_chapter',
                novelId: 'different-book',
                index: 0,
                title: 'Injected',
                normalizedText: 'test',
                textHash: 'hash',
                rawStartOffset: 0,
                rawEndOffset: 4,
                characterCount: 4,
                paragraphCount: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ]),
          ).rejects.toThrow('import_chapter_parent_conflict');
        } finally {
          client.release();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
  test('font restore rolls back when another owner wins the ID after preflight', async () => {
    await withPostgresSchema(harness!, 'font_restore_race', async (pool) => {
      await migrateDatabase(pool);
      await pool.query("insert into users(id,display_name) values('a','A'),('b','B')");
      const root = await mkdtemp(path.join(tmpdir(), 'boaa-font-race-'));
      const config = {
        ...testConfig(),
        defaultUserId: 'a',
        dataDir: root,
        objectStorageDir: path.join(root, 'objects'),
        storageCapacityPath: '',
      };
      const app = Fastify();
      let userId = 'a';
      app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
        done(null, body),
      );
      app.addHook('onRequest', async (request) => {
        request.principal = { userId, role: 'admin', authMethod: 'legacy-token' };
      });
      await registerReaderPersonalizationRoutes(app, pool, config);
      const put = (label: string, bytes: Buffer) =>
        app.inject({
          method: 'PUT',
          url: '/api/fonts/shared-font-id',
          headers: {
            'content-type': 'application/octet-stream',
            'x-font-content-type': 'font/otf',
            'x-font-family': label,
            'x-font-file-name': 'fixture.otf',
            'x-font-style': 'normal',
            'x-font-weight': '400',
            'x-font-content-hash': integrityHash(bytes),
          },
          payload: bytes,
        });
      try {
        const aBytes = Buffer.from('OTTO' + 'A'.repeat(100)),
          bBytes = Buffer.from('OTTO' + 'B'.repeat(100));
        expect((await put('FontA', aBytes)).statusCode).toBe(200);
        await pool.query(`insert into reader_settings(user_id,settings) values('a','{"fontSize":18}')`);
        const exported = await exportHostedBackup(pool, config);
        const chunks: Buffer[] = [];
        for (const reader = exported.readable.getReader(); ;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(Buffer.from(next.value));
        }
        await exported.completion;
        expect((await app.inject({ method: 'DELETE', url: '/api/fonts/shared-font-id' })).statusCode).toBe(200);
        await pool.query(`update reader_settings set settings='{"fontSize":24}' where user_id='a'`);
        let inserted = false;
        const wrapped = new Proxy(pool, {
          get(target, key) {
            if (key === 'connect')
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, field) {
                    if (field === 'query')
                      return async (sql: string, values?: unknown[]) => {
                        if (!inserted && sql.startsWith('insert into "user_fonts"')) {
                          inserted = true;
                          userId = 'b';
                          expect((await put('FontB', bBytes)).statusCode).toBe(200);
                        }
                        return connection.query(sql, values);
                      };
                    const value = Reflect.get(connection, field);
                    return typeof value === 'function' ? value.bind(connection) : value;
                  },
                });
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await expect(
          restoreHostedBackup(wrapped, config, Buffer.concat(chunks), { defaultConflictResolution: 'replace' }),
        ).rejects.toThrow('backup_restore_identity_conflict');
        expect(inserted).toBe(true);
        expect((await pool.query("select settings from reader_settings where user_id='a'")).rows[0].settings).toEqual({
          fontSize: 24,
        });
        expect((await pool.query('select user_id,family_label from user_fonts')).rows).toEqual([
          { user_id: 'b', family_label: 'FontB' },
        ]);
        const content = await app.inject('/api/fonts/shared-font-id/content');
        expect(content.statusCode).toBe(200);
        expect(content.rawPayload.equals(bBytes)).toBe(true);
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
  test('invite and reset redemption return the original login name without creating a session', async () => {
    await withPostgresSchema(harness!, 'redeem_name', async (pool) => {
      await migrateDatabase(pool);
      await pool.query("insert into users(id,display_name) values('owner','Owner')");
      const service = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'owner');
      await service.register({ username: 'owner', password: 'a secure owner password' });
      const grant = await service.invite('owner', 'Member.Name', 'Member Label');
      const app = Fastify();
      await registerSelfHostAuthRoutes(app, service, { ...testConfig(), defaultUserId: 'owner' });
      try {
        for (const [url, token] of [['/api/auth/invitations/accept', grant.token]] as const) {
          const result = await app.inject({
            method: 'POST',
            url,
            headers: { origin: 'http://localhost:80' },
            payload: { token, password: 'secure member password' },
          });
          expect(result.statusCode).toBe(200);
          expect(result.json()).toEqual({ ok: true, username: 'Member.Name', displayName: 'Member Label' });
          expect(result.headers['set-cookie']).toBeUndefined();
        }
        const reset = await service.issueAccountToken('owner', grant.account.userId, 'password-reset');
        const result = await app.inject({
          method: 'POST',
          url: '/api/auth/password-reset/complete',
          headers: { origin: 'http://localhost:80' },
          payload: { token: reset.token, password: 'new secure member password' },
        });
        expect(result.json()).toEqual({ ok: true, username: 'Member.Name', displayName: 'Member Label' });
        expect(result.headers['set-cookie']).toBeUndefined();
        expect(
          (
            await pool.query('select count(*)::integer as count from self_host_sessions where user_id=$1', [
              grant.account.userId,
            ])
          ).rows[0].count,
        ).toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});
