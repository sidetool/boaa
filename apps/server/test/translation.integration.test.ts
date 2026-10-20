// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { Queue } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../src/services/id-v2-migration/postgres-integration-harness.js';
import { registerTranslationRoutes } from '../src/translation/routes.js';
import { processTranslation } from '../src/translation/worker.js';
import {
  chargeTranslation,
  hashTranslation,
  readTranslationCredential,
  translationIsCurrent,
  type TranslationRow,
} from '../src/translation/store.js';
import { TranslationError } from '../src/translation/engine.js';
import { DEFAULT_TRANSLATION_SETTINGS } from '../../../src/translation/contracts.js';
const harness = await startPostgresIntegrationHarness();
const directory = await mkdtemp(path.join(tmpdir(), 'boaa-translation-test-'));
afterAll(async () => {
  await harness?.stop();
  await rm(directory, { recursive: true, force: true });
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
(harness ? describe : describe.skip)('translation HTTP + persisted worker', () => {
  it('encrypts secrets, enforces ownership, resumes partial output, fences cancellation and replacement', async () => {
    await withPostgresSchema(harness!, 'translation', async (pool) => {
      await pool.query(`create table users(id text primary key); insert into users values('owner'),('other');
        create table library_books(id text primary key,user_id text,format text,language text,deleted_at timestamptz,active_content_revision_id text);
        create table chapters(id text primary key,book_id text,text_hash text);
        create table book_content_revisions(id text primary key,book_id text);
        insert into book_content_revisions values('revision','book');
        create table paragraph_pages(book_id text,chapter_id text,page_index integer,paragraphs jsonb);
        create table self_host_accounts(user_id text,status text);
        insert into library_books values('book','owner','txt','ja',null,'revision');
        insert into chapters values('chapter','book','chapter-hash');`);
      await pool.query(
        (await readFile(new URL('../src/db/migrations/0061_text_translation.sql', import.meta.url), 'utf8')) +
          (await readFile(new URL('../src/db/migrations/0062_title_translation.sql', import.meta.url), 'utf8')),
      );
      const original = Array.from({ length: 6 }, (_, index) => ({
        id: `p${index}`,
        text: 'これは物語の原文です。'.repeat(70),
      }));
      await pool.query('insert into paragraph_pages values($1,$2,0,$3)', ['book', 'chapter', JSON.stringify(original)]);
      const config = loadConfig({ SERVER_DATA_DIR: directory });
      const queue = {
        getJob: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue({}),
      } as unknown as Queue;
      const app = Fastify();
      app.decorateRequest('principal', null);
      app.addHook('onRequest', async (request) => {
        request.principal = {
          userId: String(request.headers['test-owner'] ?? 'owner'),
          role: request.headers['test-member'] ? 'member' : 'admin',
          authMethod: 'legacy-token',
        };
      });
      await registerTranslationRoutes(app, pool, config, queue);
      const call = (
        method: 'GET' | 'PUT' | 'POST' | 'DELETE',
        url: string,
        payload?: object,
        headers?: Record<string, string>,
      ) => app.inject({ method, url: `/api/translation${url}`, payload, headers });
      try {
        const initial = (await call('GET', '/settings')).json();
        expect(initial.settings.enabled).toBe(false);
        const request = { bookId: 'book', workKey: 'book', chapterKey: 'chapter', revision: 'revision' };
        expect((await call('POST', '/jobs', request)).json().error).toBe('translation_disabled');
        expect((await call('GET', '/settings', undefined, { 'test-member': 'yes' })).statusCode).toBe(403);
        expect((await call('PUT', '/credentials/gemini', { value: 'synthetic-private-key' })).statusCode).toBe(200);
        const stored = (await pool.query('select * from translation_credentials')).rows[0];
        expect(JSON.stringify(stored)).not.toContain('synthetic-private-key');
        expect(await readTranslationCredential(pool, config, 'owner', 'gemini')).toBe('synthetic-private-key');
        expect((await call('GET', '/settings')).body).not.toContain('synthetic-private-key');
        const settings = {
          ...DEFAULT_TRANSLATION_SETTINGS,
          enabled: true,
          model: 'synthetic-model',
          chunkCharacters: 2000,
          retries: 0,
        };
        expect((await call('PUT', '/settings', { settings, revision: 0 })).statusCode).toBe(200);
        expect((await call('PUT', '/settings', { settings, revision: 0 })).statusCode).toBe(409);
        const created = (await call('POST', '/jobs', request)).json().result;
        expect(created.status).toBe('queued');
        expect((await call('POST', '/jobs', request)).json().result.id).toBe(created.id);
        expect((await pool.query('select count(*) from translation_jobs')).rows[0].count).toBe('1');
        expect((await call('GET', `/jobs/${created.id}`, undefined, { 'test-owner': 'other' })).statusCode).toBe(404);
        let calls = 0;
        await processTranslation(
          pool,
          config,
          created.id,
          new AbortController().signal,
          async (_s, _key, paragraphs) => {
            if (++calls === 2) throw new TranslationError('translation_auth');
            return paragraphs.map((p) => ({ id: p.id, text: `번역 ${p.paragraphId}` }));
          },
        );
        const partial = (await call('GET', `/jobs/${created.id}`)).json();
        expect(partial).toMatchObject({ status: 'failed', error: 'translation_auth', completed: 2 });
        await call('POST', '/jobs', request);
        const resumed: string[] = [];
        await processTranslation(
          pool,
          config,
          created.id,
          new AbortController().signal,
          async (_s, _key, paragraphs) => {
            resumed.push(...paragraphs.map((p) => p.paragraphId));
            return paragraphs.map((p) => ({ id: p.id, text: `번역 ${p.paragraphId}` }));
          },
        );
        const complete = (await call('GET', `/jobs/${created.id}`)).json();
        expect(complete.status).toBe('complete');
        expect(complete.completed).toBe(6);
        expect(resumed).not.toContain('p0');
        expect((await pool.query('select paragraphs from paragraph_pages')).rows[0].paragraphs).toEqual(original);
        // A new downloaded episode advances the book revision without changing this chapter.
        await pool.query("update library_books set active_content_revision_id='appended'");
        expect((await call('GET', `/jobs/${created.id}`)).statusCode).toBe(200);
        await pool.query('update library_books set deleted_at=now()');
        expect((await call('GET', `/jobs/${created.id}`)).statusCode).toBe(404);
        await pool.query('update library_books set deleted_at=null');
        await pool.query("delete from chapters where id='chapter'");
        expect((await call('GET', `/jobs/${created.id}`)).statusCode).toBe(404);
        await pool.query("insert into chapters values('chapter','book','chapter-hash')");
        expect((await call('POST', '/jobs', { ...request, chapterTextHash: 'chapter-hash' })).json().result.id).toBe(
          created.id,
        );
        // Old source fingerprints must still fail even if the caller knows a valid book revision.
        expect((await call('POST', '/jobs', { ...request, chapterTextHash: 'wrong-hash' })).statusCode).toBe(409);
        await call('DELETE', '/cache');
        const duringAppend = (await call('POST', '/jobs', { ...request, chapterTextHash: 'chapter-hash' })).json()
          .result;
        await processTranslation(
          pool,
          config,
          duringAppend.id,
          new AbortController().signal,
          async (_s, _key, paragraphs) => {
            await pool.query("update library_books set active_content_revision_id='appended-again'");
            return paragraphs.map((p) => ({ id: p.id, text: '회차 추가 후에도 번역 유지' }));
          },
        );
        expect((await call('GET', `/jobs/${duringAppend.id}`)).json().status).toBe('complete');
        await pool.query("update library_books set active_content_revision_id='revision'");
        // Already cached chapters are never synthesized again.
        expect((await call('POST', '/jobs', request)).json().result.status).toBe('complete');
        await call('DELETE', '/cache');
        const cancellation = (await call('POST', '/jobs', request)).json().result;
        await processTranslation(
          pool,
          config,
          cancellation.id,
          new AbortController().signal,
          async (_s, _key, paragraphs) => {
            await call('DELETE', `/jobs/${cancellation.id}`);
            return paragraphs.map((p) => ({ id: p.id, text: 'late' }));
          },
        );
        const cancelled = (await call('GET', `/jobs/${cancellation.id}`)).json();
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.paragraphs).toEqual([]);
        await call('POST', '/jobs', request);
        await processTranslation(
          pool,
          config,
          cancellation.id,
          new AbortController().signal,
          async (_s, _key, paragraphs) => {
            await pool.query("update library_books set active_content_revision_id='replaced'");
            await pool.query(
              'update paragraph_pages set paragraphs=\'[{"id":"p0","text":"Changed original"}]\'::jsonb',
            );
            return paragraphs.map((p) => ({ id: p.id, text: 'stale' }));
          },
        );
        expect((await call('GET', `/jobs/${cancellation.id}`)).statusCode).toBe(404);
        expect((await pool.query('select output from translation_jobs')).rows[0].output).toEqual([]);
        expect((await call('POST', '/jobs', request)).statusCode).toBe(409);
        // No implicit call for same-language or uncertain transient works.
        expect(
          (
            await call('POST', '/jobs', {
              workKey: 'stream',
              chapterKey: 'one',
              paragraphs: [{ id: 's1', text: 'Hello' }],
            })
          ).json().error,
        ).toBe('translation_language_confirmation');
        expect(
          (
            await call('POST', '/jobs', {
              workKey: 'stream',
              chapterKey: 'one',
              sourceLanguage: 'ko',
              paragraphs: [{ id: 's1', text: '안녕하세요' }],
            })
          ).json().error,
        ).toBe('translation_same_language');
        await pool.query('delete from translation_daily_usage');
        // Previously saved caps are ignored, including during concurrent accounting.
        const budgetRow = { user_id: 'owner', settings: { ...settings, dailyCharacters: 1000 } };
        const charged = await Promise.allSettled([
          chargeTranslation(pool, budgetRow, 700),
          chargeTranslation(pool, budgetRow, 700),
        ]);
        expect(charged.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
        expect(Number((await pool.query('select characters from translation_daily_usage')).rows[0].characters)).toBe(
          1400,
        );
        await expect(readTranslationCredential(pool, config, 'other', 'gemini')).rejects.toThrow(
          'translation_secret_required',
        );
      } finally {
        await app.close();
      }
    });
  }, 60000);
});

(harness ? describe : describe.skip)('translation source and execution invariants', () => {
  async function fixture(
    run: (context: {
      pool: import('pg').Pool;
      config: ReturnType<typeof loadConfig>;
      call: (
        method: 'GET' | 'PUT' | 'POST' | 'DELETE',
        url: string,
        payload?: object,
      ) => ReturnType<ReturnType<typeof Fastify>['inject']>;
    }) => Promise<void>,
  ) {
    await withPostgresSchema(harness!, 'translation_invariants', async (pool) => {
      await pool.query(`create table users(id text primary key); insert into users values('owner');
        create table library_books(id text primary key,user_id text,format text,language text,deleted_at timestamptz,active_content_revision_id text);
        create table chapters(id text primary key,book_id text,text_hash text);
        create table book_content_revisions(id text primary key,book_id text);
        create table paragraph_pages(book_id text,chapter_id text,page_index integer,paragraphs jsonb);
        create table self_host_accounts(user_id text,status text);
        insert into library_books values('book','owner','epub','ja',null,'revision');
        insert into chapters values('chapter','book','chapter-hash');
        insert into book_content_revisions values('revision','book');`);
      await pool.query(
        (await readFile(new URL('../src/db/migrations/0061_text_translation.sql', import.meta.url), 'utf8')) +
          (await readFile(new URL('../src/db/migrations/0062_title_translation.sql', import.meta.url), 'utf8')),
      );
      await pool.query('insert into paragraph_pages values($1,$2,0,$3)', [
        'book',
        'chapter',
        JSON.stringify([{ id: 'p1', text: 'Synthetic chapter original' }]),
      ]);
      const config = loadConfig({ SERVER_DATA_DIR: directory });
      const app = Fastify();
      app.decorateRequest('principal', null);
      app.addHook('onRequest', async (request) => {
        request.principal = { userId: 'owner', role: 'admin', authMethod: 'legacy-token' };
      });
      await registerTranslationRoutes(app, pool, config, {
        getJob: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue({}),
      } as unknown as Queue);
      const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
        app.inject({ method, url: `/api/translation${url}`, payload });
      try {
        await call('PUT', '/credentials/gemini', { value: 'synthetic-original-key' });
        await call('PUT', '/settings', {
          settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, model: 'synthetic', retries: 0 },
          revision: 0,
        });
        await run({ pool, config, call });
      } finally {
        await app.close();
      }
    });
  }
  const saved = { bookId: 'book', workKey: 'book', chapterKey: 'chapter', revision: 'revision' };
  it('separates saved and transient cache provenance even when identifiers and paragraphs coincide', async () => {
    await fixture(async ({ pool, call }) => {
      const stream = (
        await call('POST', '/jobs', {
          workKey: 'book',
          chapterKey: 'chapter',
          sourceLanguage: 'ja',
          paragraphs: [{ id: 'p1', text: 'Synthetic chapter original' }],
        })
      ).json().result;
      // Old installations hashed just the paragraphs: even those rows require matching provenance.
      await pool.query('update translation_jobs set source_hash=$1 where id=$2', [
        hashTranslation([{ id: 'p1', text: 'Synthetic chapter original' }]),
        stream.id,
      ]);
      const stored = (await call('POST', '/jobs', saved)).json().result;
      expect(stored.id).not.toBe(stream.id);
      await pool.query("update library_books set deleted_at=now() where id='book'");
      expect((await call('GET', `/jobs/${stored.id}`)).statusCode).toBe(404);
      expect((await call('GET', `/jobs/${stream.id}`)).statusCode).toBe(200);
    });
  }, 60000);
  it.each(['replace-key', 'delete-key', 'disable', 'cancel', 'cache', 'suspend', 'purge'] as const)(
    'fences late output after %s',
    async (action) => {
      await fixture(async ({ pool, config, call }) => {
        const row = (await call('POST', '/jobs', saved)).json().result;
        await processTranslation(
          pool,
          config,
          row.id,
          new AbortController().signal,
          async (_settings, credential, parts) => {
            expect(credential).toBe('synthetic-original-key');
            if (action === 'replace-key')
              await call('PUT', '/credentials/gemini', { value: 'synthetic-replacement-key' });
            if (action === 'delete-key') await call('DELETE', '/credentials/gemini');
            if (action === 'disable')
              await call('PUT', '/settings', {
                settings: { ...DEFAULT_TRANSLATION_SETTINGS, model: 'synthetic' },
                revision: 1,
              });
            if (action === 'cancel') await call('DELETE', `/jobs/${row.id}`);
            if (action === 'cache') await call('DELETE', '/cache');
            if (action === 'suspend') await pool.query("insert into self_host_accounts values('owner','suspended')");
            if (action === 'purge') {
              await pool.query("delete from library_books where id='book'");
              await pool.query("insert into library_books values('book','owner','epub','ja',null,'revision')");
            }
            return parts.map((part) => ({ id: part.id, text: 'Late translation' }));
          },
        );
        const rows = (await pool.query('select * from translation_jobs where id=$1', [row.id])).rows;
        if (action === 'cache' || action === 'purge') expect(rows).toHaveLength(0);
        else {
          expect(rows[0].status).not.toBe('complete');
          expect(rows[0].output).toEqual([]);
        }
      });
    },
    60000,
  );
  it('keeps the resumed execution when the cancelled provider response arrives last', async () => {
    await fixture(async ({ pool, config, call }) => {
      const created = (await call('POST', '/jobs', saved)).json().result;
      await processTranslation(
        pool,
        config,
        created.id,
        new AbortController().signal,
        async (_settings, _key, parts) => {
          expect((await call('DELETE', `/jobs/${created.id}`)).statusCode).toBe(200);
          expect((await call('POST', '/jobs', saved)).json().result.id).toBe(created.id);
          await processTranslation(
            pool,
            config,
            created.id,
            new AbortController().signal,
            async (_newSettings, _newKey, newParts) => newParts.map((part) => ({ id: part.id, text: 'New execution' })),
          );
          return parts.map((part) => ({ id: part.id, text: 'Cancelled execution arrived last' }));
        },
      );
      expect((await call('GET', `/jobs/${created.id}`)).json()).toMatchObject({
        status: 'complete',
        paragraphs: [{ id: 'p1', text: 'New execution' }],
      });
    });
  }, 60000);
  it('deduplicates concurrent requests for the same saved source', async () => {
    await fixture(async ({ pool, call }) => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/jobs', saved)));
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(new Set(responses.map((response) => response.json().result.id)).size).toBe(1);
      expect((await pool.query('select count(*) from translation_jobs')).rows[0].count).toBe('1');
    });
  }, 60000);
  it('checks exact paragraph identity even if a revision token is reused, and allows exact restoration', async () => {
    await fixture(async ({ pool, config, call }) => {
      const row = (await call('POST', '/jobs', saved)).json().result;
      await processTranslation(pool, config, row.id, new AbortController().signal, async (_settings, _key, parts) =>
        parts.map((part) => ({ id: part.id, text: 'Saved translation' })),
      );
      await pool.query(`update paragraph_pages set paragraphs='[{"id":"p1","text":"Changed under same revision"}]'`);
      expect((await call('GET', `/jobs/${row.id}`)).statusCode).toBe(404);
      await pool.query(`update paragraph_pages set paragraphs='[{"id":"p1","text":"Synthetic chapter original"}]'`);
      expect((await call('GET', `/jobs/${row.id}`)).json().status).toBe('complete');
    });
  }, 60000);
  it('reuses legacy saved caches and resumes legacy partial jobs without changing identity', async () => {
    await fixture(async ({ pool, config, call }) => {
      const row = (await call('POST', '/jobs', saved)).json().result;
      const legacyHash = hashTranslation([{ id: 'p1', text: 'Synthetic chapter original' }]);
      await pool.query(
        `update translation_jobs set source_hash=$1,status='failed',output='[{"id":"p1","text":"Previously saved"}]',completed=1 where id=$2`,
        [legacyHash, row.id],
      );
      expect((await call('POST', '/jobs', saved)).json().result.id).toBe(row.id);
      const synthesize = vi.fn();
      await processTranslation(pool, config, row.id, new AbortController().signal, synthesize);
      expect(synthesize).not.toHaveBeenCalled();
      expect((await call('POST', '/jobs', saved)).json().result).toMatchObject({
        id: row.id,
        status: 'complete',
        sourceHash: legacyHash,
        paragraphs: [{ id: 'p1', text: 'Previously saved' }],
      });
    });
  }, 60000);
  it('keeps blank/nontext EPUB blocks out of paid input and resumes only whole completed paragraphs', async () => {
    await fixture(async ({ pool, config, call }) => {
      await pool.query('update paragraph_pages set paragraphs=$1', [
        JSON.stringify([
          { id: 'blank', text: ' \n' },
          { id: 'image', text: 'Image caption', documentKind: 'image' },
          { id: 'separator', text: 'Divider', documentKind: 'separator' },
          { id: 'short', text: 'Short source' },
          { id: 'long', text: '😀'.repeat(2400) },
        ]),
      ]);
      await call('PUT', '/settings', {
        settings: {
          ...DEFAULT_TRANSLATION_SETTINGS,
          enabled: true,
          model: 'synthetic',
          retries: 0,
          chunkCharacters: 2000,
          concurrency: 2,
        },
        revision: 1,
      });
      const row = (await call('POST', '/jobs', saved)).json().result;
      await processTranslation(pool, config, row.id, new AbortController().signal, async (_settings, _key, parts) => {
        expect(parts.every((part) => ['short', 'long'].includes(part.paragraphId))).toBe(true);
        if (parts.some((part) => part.paragraphId === 'long' && part.part === 2))
          throw new TranslationError('translation_auth');
        return parts.map((part) => ({
          id: part.id,
          text: part.paragraphId === 'short' ? 'Short translated' : 'Long fragment',
        }));
      });
      const partial = (await call('GET', `/jobs/${row.id}`)).json();
      expect(partial).toMatchObject({
        status: 'failed',
        total: 2,
        completed: 1,
        paragraphs: [{ id: 'short', text: 'Short translated' }],
      });
      await call('POST', '/jobs', saved);
      const resumed: string[] = [];
      await processTranslation(pool, config, row.id, new AbortController().signal, async (_settings, _key, parts) => {
        resumed.push(...parts.map((part) => part.paragraphId));
        return parts.map((part) => ({ id: part.id, text: 'Fragment' }));
      });
      expect(resumed).toEqual(['long', 'long', 'long']);
      expect((await call('GET', `/jobs/${row.id}`)).json()).toMatchObject({
        status: 'complete',
        completed: 2,
        total: 2,
        paragraphs: [
          { id: 'short', text: 'Short translated' },
          { id: 'long', text: 'FragmentFragmentFragment' },
        ],
      });
    });
  }, 60000);
  it('measures bounded exact-source checks at the 500k character / 10k paragraph limit', async () => {
    await fixture(async ({ pool, call }) => {
      const paragraphs = Array.from({ length: 10000 }, (_, index) => ({
        id: `p${index}`,
        text: `${index}`.padEnd(50, 'x'),
      }));
      await pool.query('update paragraph_pages set paragraphs=$1', [JSON.stringify(paragraphs)]);
      const created = (await call('POST', '/jobs', saved)).json().result;
      const row = (
        await pool.query<TranslationRow>(
          "update translation_jobs set status='running',execution_id='synthetic-execution' where id=$1 returning *",
          [created.id],
        )
      ).rows[0];
      const samples: number[] = [];
      for (let iteration = 0; iteration < 10; iteration++) {
        const start = performance.now();
        expect(await translationIsCurrent(pool, row, 'synthetic-execution')).toBe(true);
        samples.push(performance.now() - start);
      }
      process.stdout.write(
        'translation 500k/10k exact proof ms ' +
          JSON.stringify({
            mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
            max: Math.max(...samples),
          }) +
          '\n',
      );
    });
  }, 60000);
  async function enableTitles(call: Parameters<Parameters<typeof fixture>[0]>[0]['call']) {
    const current = (await call('GET', '/settings')).json();
    const settings = { ...current.settings, translateTitles: true, dailyCharacters: 1 };
    expect((await call('PUT', '/settings', { settings, revision: current.revision })).statusCode).toBe(200);
  }
  it('batches titles, reuses each result across lists and concurrent callers, and preserves originals', async () => {
    await fixture(async ({ pool, config, call }) => {
      const titles = ['The First Story', 'The Second Story', '한국어 작품'];
      expect(
        (await call('POST', '/titles', { titles }))
          .json()
          .titles.every((t: { status: string }) => t.status === 'original'),
      ).toBe(true);
      expect((await pool.query('select count(*) from translation_jobs')).rows[0].count).toBe('0');
      await enableTitles(call);
      await pool.query('update translation_settings set settings=settings || \'{"dailyCharacters":1}\'::jsonb');
      const responses = await Promise.all([
        call('POST', '/titles', { titles }),
        call('POST', '/titles', { titles: [...titles].reverse() }),
      ]);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const rows = (await pool.query<TranslationRow>('select * from translation_jobs')).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('titles');
      expect(rows[0].input.map((part) => part.text)).toEqual(titles.slice(0, 2));
      const translate = vi.fn(async (_s, _key, parts, _signal, purpose) => {
        expect(purpose).toBe('titles');
        return parts.map((part: { id: string; text: string }) => ({ id: part.id, text: `번역 ${part.text}` }));
      });
      await processTranslation(pool, config, rows[0].id, new AbortController().signal, translate);
      expect(translate).toHaveBeenCalledTimes(1);
      const result = (
        await call('POST', '/titles', { titles: [titles[1], titles[0], titles[0], 'A New Story'] })
      ).json();
      expect(result.titles.slice(0, 2)).toEqual([
        { original: titles[1], translated: `번역 ${titles[1]}`, status: 'complete' },
        { original: titles[0], translated: `번역 ${titles[0]}`, status: 'complete' },
      ]);
      const next = (await pool.query<TranslationRow>("select * from translation_jobs where status='queued'")).rows;
      expect(next).toHaveLength(1);
      expect(next[0].input.map((part) => part.text)).toEqual(['A New Story']);
      expect((await pool.query('select paragraphs from paragraph_pages')).rows[0].paragraphs).toEqual([
        { id: 'p1', text: 'Synthetic chapter original' },
      ]);
      expect(
        Number((await pool.query('select characters from translation_daily_usage')).rows[0].characters),
      ).toBeGreaterThan(1);
      expect((await call('GET', '/settings')).json().settings).not.toHaveProperty('dailyCharacters');
      await call('DELETE', '/cache');
      expect((await pool.query('select count(*) from translation_titles')).rows[0].count).toBe('0');
    });
  }, 60000);
  it('isolates title results by account and translation profile, rejects unbounded batches', async () => {
    await fixture(async ({ pool, config, call }) => {
      await enableTitles(call);
      expect((await call('POST', '/titles', { titles: Array(25).fill('Title') })).statusCode).toBe(400);
      expect((await call('POST', '/titles', { titles: ['x'.repeat(501)] })).statusCode).toBe(400);
      expect((await call('POST', '/titles', { titles: [''] })).statusCode).toBe(400);
      const titles = ['An Original Title'];
      await call('POST', '/titles', { titles });
      const job = (await pool.query<TranslationRow>('select * from translation_jobs')).rows[0];
      await processTranslation(pool, config, job.id, new AbortController().signal, async (_s, _key, parts) =>
        parts.map((p) => ({ id: p.id, text: '한국어 제목' })),
      );
      await pool.query("insert into users values('other')");
      await pool.query("insert into translation_settings(user_id,settings) values('other',$1)", [job.settings]);
      const { requestTitleTranslations } = await import('../src/translation/titles.js');
      expect((await requestTitleTranslations(pool, 'other', titles)).response.titles).toEqual([
        { original: titles[0], status: 'original' },
      ]);
      const current = (await call('GET', '/settings')).json();
      await call('PUT', '/settings', {
        settings: { ...current.settings, targetLanguage: 'ja' },
        revision: current.revision,
      });
      expect((await call('POST', '/titles', { titles })).json().titles[0]).not.toHaveProperty('translated');
      expect((await pool.query('select count(*) from translation_jobs')).rows[0].count).toBe('2');
    });
  }, 60000);
  it.each(['disable-titles', 'delete-key', 'clear-cache'] as const)(
    'fences title output after %s',
    async (action) => {
      await fixture(async ({ pool, config, call }) => {
        await enableTitles(call);
        await call('POST', '/titles', { titles: ['An Interrupted Title'] });
        const job = (await pool.query<TranslationRow>('select * from translation_jobs')).rows[0];
        await processTranslation(pool, config, job.id, new AbortController().signal, async (_s, _key, parts) => {
          if (action === 'clear-cache') await call('DELETE', '/cache');
          else if (action === 'delete-key') await call('DELETE', '/credentials/gemini');
          else {
            const current = (await call('GET', '/settings')).json();
            await call('PUT', '/settings', {
              settings: { ...current.settings, translateTitles: false },
              revision: current.revision,
            });
          }
          return parts.map((p) => ({ id: p.id, text: 'Must not commit' }));
        });
        expect((await pool.query("select * from translation_jobs where status='complete'")).rows).toHaveLength(0);
      });
    },
    60000,
  );
  it('does not retry failed paid title jobs on polling; a corrected key allows one retry', async () => {
    await fixture(async ({ pool, config, call }) => {
      await enableTitles(call);
      const titles = ['A Failed Title'];
      await call('POST', '/titles', { titles });
      const job = (await pool.query<TranslationRow>('select * from translation_jobs')).rows[0];
      const fail = vi.fn(async () => {
        throw new TranslationError('translation_auth');
      });
      await processTranslation(pool, config, job.id, new AbortController().signal, fail);
      for (let i = 0; i < 3; i++)
        expect((await call('POST', '/titles', { titles })).json().titles[0].status).toBe('failed');
      expect(fail).toHaveBeenCalledTimes(1);
      await call('PUT', '/credentials/gemini', { value: 'synthetic-corrected-key' });
      expect((await call('POST', '/titles', { titles })).json().titles[0].status).toBe('queued');
      expect((await pool.query('select count(*) from translation_jobs')).rows[0].count).toBe('1');
    });
  }, 60000);
  it('re-enables cancelled titles without interrupting an unrelated chapter job', async () => {
    await fixture(async ({ pool, config, call }) => {
      const chapter = (await call('POST', '/jobs', saved)).json().result;
      await enableTitles(call);
      expect((await call('GET', `/jobs/${chapter.id}`)).json().status).toBe('queued');
      const titles = ['Interrupted Title'];
      await call('POST', '/titles', { titles });
      const job = (await pool.query<TranslationRow>("select * from translation_jobs where kind='titles'")).rows[0];
      const before = (await call('GET', '/settings')).json();
      await call('PUT', '/settings', {
        settings: { ...before.settings, translateTitles: false },
        revision: before.revision,
      });
      await enableTitles(call);
      await call('POST', '/titles', { titles: ['Pending batch one'] });
      await call('POST', '/titles', { titles: ['Pending batch two'] });
      expect((await call('POST', '/titles', { titles })).json().titles[0].status).toBe('queued');
      expect((await pool.query('select status from translation_jobs where id=$1', [job.id])).rows[0].status).toBe(
        'cancelled',
      );
      const waiting = (
        await pool.query<TranslationRow>("select * from translation_jobs where kind='titles' and status='queued'")
      ).rows;
      for (const pending of waiting)
        await processTranslation(pool, config, pending.id, new AbortController().signal, async (_s, _key, parts) =>
          parts.map((p) => ({ id: p.id, text: '대기 해제' })),
        );
      await call('POST', '/titles', { titles });
      await processTranslation(pool, config, job.id, new AbortController().signal, async (_s, _key, parts) =>
        parts.map((p) => ({ id: p.id, text: '재개한 제목' })),
      );
      expect((await call('POST', '/titles', { titles })).json().titles[0].translated).toBe('재개한 제목');
    });
  }, 60000);
});
