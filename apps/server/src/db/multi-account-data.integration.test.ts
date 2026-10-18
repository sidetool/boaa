import { parseHostedBackupArchive } from '../services/hosted-backup-archive.js';
import { restoreHostedBackup } from '../services/hosted-backup-service.js';
import type { RequestPrincipal } from '@boaa/contracts';
import { registerBackupRoutes } from '../routes/backups.js';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadMigrations, migrateDatabase } from './migrate.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { processImportJob } from '../services/import-service.js';
import { registerBookRoutes } from '../routes/books.js';
import { registerUploadRoutes } from '../routes/uploads.js';
import { testConfig } from '../routes/books/books-route-test-harness.js';
import type { Queue } from 'bullmq';

const harness = await startPostgresIntegrationHarness();
if (harness?.source === 'environment') throw new Error('This fixture requires an isolated temporary database');
const suite = harness ? describe : describe.skip;
async function source(format: string) {
  if (format === 'pdf') {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>',
      '<< /Length 0 >>\nstream\n\nendstream',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const start = Buffer.byteLength(pdf);
    pdf +=
      'xref\n0 5\n0000000000 65535 f \n' +
      offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join('') +
      `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(pdf);
  }
  if (format === 'txt') return Buffer.from('Chapter 1\n\nA shared synthetic book.\n\nSecond paragraph.');
  const zip = new ZipWriter(new BlobWriter());
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  );
  await zip.add('001.png', new Uint8ArrayReader(png));
  if (format === 'epub') {
    await zip.add(
      'META-INF/container.xml',
      new TextReader('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    );
    await zip.add(
      'book.opf',
      new TextReader(
        '<package><metadata><title>Fixture</title></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="image" href="001.png" media-type="image/png"/></manifest><spine><itemref idref="text"/></spine></package>',
      ),
    );
    await zip.add(
      'text.xhtml',
      new TextReader('<html><body><p>Shared EPUB text.</p><img src="001.png"/></body></html>'),
    );
  }
  return Buffer.from(await (await zip.close()).arrayBuffer());
}
suite('two-account persisted data isolation', () => {
  afterAll(async () => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
  test('migration preserves legacy object identity and rejects cross-owner parent links', async () => {
    await withPostgresSchema(harness!, 'owner_legacy', async (pool) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'boaa-owner-migrations-'));
      try {
        for (const migration of await loadMigrations())
          if (migration.version < 60) await writeFile(path.join(directory, migration.fileName), migration.sql);
        await migrateDatabase(pool, { migrationsDirectory: directory });
        await pool.query("insert into users(id,email,display_name) values('legacy','legacy@example.test','Legacy')");
        await pool.query(
          "insert into book_objects(id,raw_text_hash,storage_key,file_name,content_type,size_bytes) values('old-object','sha256:old','unchanged/key','original.txt','text/plain',100)",
        );
        await pool.query(
          "insert into library_books(id,user_id,object_id,title,source_file_name,normalized_text_hash,total_chapters,total_characters,total_paragraphs) values('old-book','legacy','old-object','Preserved','original.txt','same-text',0,0,0)",
        );
        await migrateDatabase(pool);
        expect((await pool.query('select id,user_id,storage_key from book_objects')).rows).toEqual([
          { id: 'old-object', user_id: 'legacy', storage_key: 'unchanged/key' },
        ]);
        expect((await pool.query('select id,object_id from library_books')).rows).toEqual([
          { id: 'old-book', object_id: 'old-object' },
        ]);
        await pool.query("insert into users(id,email,display_name) values('member','member@example.test','Member')");
        await pool.query(
          "insert into book_objects(id,user_id,raw_text_hash,storage_key,file_name,content_type,size_bytes) values('new-object','member','sha256:old','member/key','original.txt','text/plain',100)",
        );
        await expect(
          pool.query("update library_books set object_id='new-object' where id='old-book'"),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }, 120_000);
  test.each(['txt', 'epub', 'cbz', 'pdf'])(
    'same %s imports have disjoint graphs and known IDs cannot access uploads or books',
    async (format) => {
      await withPostgresSchema(harness!, 'owner_data', async (pool) => {
        await migrateDatabase(pool);
        await pool.query(
          "insert into users(id,email,display_name) values('a','a@example.test','A'),('b','b@example.test','B')",
        );
        const dir = await mkdtemp(path.join(os.tmpdir(), 'boaa-owner-fixture-'));
        const config = {
          ...testConfig(),
          defaultUserId: 'a',
          dataDir: dir,
          objectStorageDir: path.join(dir, 'objects'),
          storageCapacityPath: '',
        };
        await pool.query(
          "insert into self_host_accounts(user_id,bootstrap_owner_key,username,normalized_username,display_name,role,password_scheme,password_salt,password_digest) values('a',1,'a','a','Admin','admin','scrypt-v1','c2FsdA==','ZGlnZXN0')",
        );
        const bytes = await source(format);
        try {
          for (const user of ['a', 'b']) {
            const upload = `upload_${user}`;
            const folder = path.join(dir, 'uploads', upload);
            await mkdir(folder, { recursive: true });
            const chunk = path.join(folder, '00000000.part');
            await writeFile(chunk, bytes);
            await pool.query(
              `insert into upload_sessions(id,user_id,file_name,size_bytes,content_type,encoding,status,total_chunks) values($1,$2,$4,$3,'application/octet-stream','utf-8','queued',1)`,
              [upload, user, bytes.length, `same.${format}`],
            );
            await pool.query(
              'insert into upload_chunks(upload_id,chunk_index,size_bytes,storage_path) values($1,0,$2,$3)',
              [upload, bytes.length, chunk],
            );
            await pool.query("insert into import_jobs(id,user_id,upload_id,status) values($1,$2,$3,'queued')", [
              `job_${user}`,
              user,
              upload,
            ]);
          }
          await expect(processImportJob(pool, config, 'job_a', 'upload_b')).rejects.toThrow(
            'import_job_upload_mismatch',
          );
          await processImportJob(pool, config, 'job_a', 'upload_a');
          await processImportJob(pool, config, 'job_b', 'upload_b');
          const jobs = await pool.query('select status,error_message from import_jobs order by id');
          expect(jobs.rows).toEqual([
            { status: 'done', error_message: null },
            { status: 'done', error_message: null },
          ]);
          const books = await pool.query('select id,user_id,object_id from library_books order by user_id');
          expect(books.rows).toHaveLength(2);
          expect(books.rows[0].id).not.toMatch(/^hosted_book_/);
          const repeatDir = path.join(dir, 'uploads', 'upload_repeat');
          await mkdir(repeatDir, { recursive: true });
          const repeatChunk = path.join(repeatDir, '00000000.part');
          await writeFile(repeatChunk, bytes);
          await pool.query(
            "insert into upload_sessions(id,user_id,file_name,size_bytes,content_type,encoding,status,total_chunks) values('upload_repeat','a',$1,$2,'application/octet-stream','utf-8','queued',1)",
            [`same.${format}`, bytes.length],
          );
          await pool.query(
            "insert into upload_chunks(upload_id,chunk_index,size_bytes,storage_path) values('upload_repeat',0,$1,$2)",
            [bytes.length, repeatChunk],
          );
          await pool.query(
            "insert into import_jobs(id,user_id,upload_id,status) values('job_repeat','a','upload_repeat','queued')",
          );
          await processImportJob(pool, config, 'job_repeat', 'upload_repeat');
          expect((await pool.query("select status,book_id from import_jobs where id='job_repeat'")).rows[0]).toEqual({
            status: 'done',
            book_id: books.rows[0].id,
          });
          expect((await pool.query('select count(*)::int as n from library_books')).rows[0].n).toBe(2);
          expect(books.rows[0].id).not.toBe(books.rows[1].id);
          expect(books.rows[0].object_id).not.toBe(books.rows[1].object_id);
          const objects = await pool.query('select user_id,raw_text_hash from book_objects order by user_id');
          expect(objects.rows[0].raw_text_hash).toBe(objects.rows[1].raw_text_hash);
          const app = Fastify();
          app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
            done(null, body),
          );
          let principal: RequestPrincipal | null = {
            userId: 'b',
            role: 'member',
            authMethod: 'session',
            sessionContext: 'b-session',
          };
          app.addHook('onRequest', async (req) => {
            req.principal = principal;
          });
          await registerBookRoutes(app, pool, config);
          await registerUploadRoutes(app, pool, config, {} as Queue);
          await registerBackupRoutes(app, pool, config);
          try {
            expect((await app.inject(`/api/books/${books.rows[0].id}/manifest`)).statusCode).toBe(404);
            expect((await app.inject(`/api/books/${books.rows[1].id}/manifest`)).statusCode).toBe(200);
            for (const url of ['/api/uploads/upload_a', '/api/import-jobs/job_a'])
              expect((await app.inject(url)).statusCode).toBe(404);
            expect((await app.inject({ method: 'DELETE', url: '/api/uploads/upload_a' })).statusCode).toBe(404);
            expect((await app.inject({ method: 'POST', url: '/api/uploads/upload_a/complete' })).statusCode).toBe(404);
            expect(
              (
                await app.inject({
                  method: 'PUT',
                  url: '/api/uploads/upload_a/chunks/0',
                  headers: { 'content-type': 'application/octet-stream' },
                  payload: bytes,
                })
              ).statusCode,
            ).toBe(404);
            expect((await app.inject({ method: 'POST', url: '/api/backups/restore' })).statusCode).toBe(403);
            const download = await app.inject({
              method: 'POST',
              url: `/api/books/${books.rows[1].id}/original-files/${books.rows[1].object_id}/download`,
            });
            expect(download.statusCode).toBe(200);
            const ticketUrl = `/api/original-downloads/${download.json().ticket}`;
            principal = { userId: 'a', role: 'admin', authMethod: 'session', sessionContext: 'a-session' };
            expect((await app.inject(ticketUrl)).statusCode).toBe(410);
            principal = null;
            expect((await app.inject(ticketUrl)).statusCode).toBe(410);
            principal = { userId: 'b', role: 'member', authMethod: 'session', sessionContext: 'b-session' };
            expect((await app.inject(ticketUrl)).statusCode).toBe(200);
            const backupTicket = (await app.inject({ method: 'POST', url: '/api/backups/download' })).json().ticket;
            principal = { userId: 'a', role: 'admin', authMethod: 'session', sessionContext: 'a-session' };
            expect((await app.inject(`/api/backups/download/${backupTicket}`)).statusCode).toBe(410);
            principal = { userId: 'b', role: 'member', authMethod: 'session', sessionContext: 'b-session' };
            const exported = await app.inject(`/api/backups/download/${backupTicket}`);
            expect(exported.statusCode).toBe(200);
            const archive = await parseHostedBackupArchive(exported.rawPayload);
            expect(archive.tables.get('library_books')?.map((row) => row.user_id)).toEqual(['b']);
            await expect(
              restoreHostedBackup(pool, config, archive, { defaultConflictResolution: 'replace' }),
            ).rejects.toThrow('cross_account_backup_restore_unsupported');
            for (const rows of archive.tables.values()) for (const row of rows) if ('user_id' in row) row.user_id = 'a';
            await expect(
              restoreHostedBackup(pool, config, archive, { defaultConflictResolution: 'replace' }),
            ).rejects.toThrow('backup_contains_foreign_identity');
            expect((await pool.query('select count(*)::int as n from library_books')).rows[0].n).toBe(2);
            const referenceArchive = { ...archive, tables: new Map(archive.tables), objects: [] };
            referenceArchive.tables.clear();
            referenceArchive.tables.set('library_books', [
              { id: 'new-book', user_id: 'a', object_id: books.rows[1].object_id, title: 'Reference fixture' },
            ]);
            await expect(
              restoreHostedBackup(pool, config, referenceArchive, { defaultConflictResolution: 'replace' }),
            ).rejects.toThrow('backup_contains_foreign_reference');
            principal = { userId: 'a', role: 'admin', authMethod: 'legacy-token' };
            const legacy = (
              await app.inject({
                method: 'POST',
                url: `/api/books/${books.rows[0].id}/original-files/${books.rows[0].object_id}/download`,
              })
            ).json().ticket;
            principal = null;
            expect((await app.inject(`/api/original-downloads/${legacy}`)).statusCode).toBe(200);
          } finally {
            await app.close();
          }
          await pool.query(
            "insert into sync_events(id,user_id,type,payload) values('same-event','a','test','{}'),('same-event','b','test','{}')",
          );
          expect((await pool.query("select count(*)::int as n from sync_events where id='same-event'")).rows[0].n).toBe(
            2,
          );
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
    120_000,
  );
});
