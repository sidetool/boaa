import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from './id-v2-migration/postgres-integration-harness.js';
import { loadConfig } from '../config.js';
import type { TTSSynthesisProvider } from '../../../../src/providers/tts';
import { AudiobookService, AUDIOBOOK_QUOTA_BYTES } from './audiobook-service.js';
import { AudiobookAudioStore } from './audiobook-audio.js';
import { registerAudiobookRoutes } from '../routes/ai/audiobook-routes.js';
import { parsePlainTTSRules, classifyPlainTTSFailure, registerPlainTTSRoutes } from '../routes/ai/plain-tts-routes.js';
import type { ServerConfig } from '../config.js';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSRequest } from '../../../../src/providers/plain-tts';
import { structuredIntegrityHash } from '@boaa/text-core/hash';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
const settings: AudiobookInput = {
  chapterIds: ['c2', 'c1'],
  voiceId: 'fixture:voice',
  modelRevision: 'model',
  chunking: 'sentence',
  footnotePlayback: 'skip',
  rules: [],
};
const catalog = async () => ({
  available: true,
  revision: 'model',
  voices: [{ id: 'fixture:voice', label: 'Fixture', lang: 'ko', paid: true, providerName: 'Fixture API' }],
});
async function setup(pool: pg.Pool) {
  await pool.query(`create table users(id text primary key);
    create table library_books(id text primary key,user_id text,title text,format text,language text,active_content_revision_id text,deleted_at timestamptz);
    create table chapters(id text primary key,book_id text,title text,chapter_index integer);
    create table paragraph_search(book_id text,chapter_id text,paragraph_id text,paragraph_index integer,paragraph jsonb,text text);
    create table self_host_accounts(user_id text,role text,status text);
    insert into users values('owner'),('other');
    insert into library_books values('book','owner','Fixture Book','txt','ko','revision',null);
    insert into chapters values('c1','book','First',1),('c2','book','Second',2);
    insert into self_host_accounts values('owner','admin','active');`);
  await pool.query(await readFile(new URL('../db/migrations/0065_saved_audiobooks.sql', import.meta.url), 'utf8'));
  for (const chapterId of ['c1', 'c2'])
    for (let index = 1; index <= 2; index++) {
      const paragraph = {
        id: `${chapterId}-${index}`,
        chapterId,
        novelId: 'book',
        index,
        text: `테스트 ${index} 문장입니다.`,
        textHash: 'fixture',
        startOffsetInChapter: 0,
        endOffsetInChapter: 15,
      };
      await pool.query('insert into paragraph_search values($1,$2,$3,$4,$5,$6)', [
        'book',
        chapterId,
        paragraph.id,
        index,
        paragraph,
        paragraph.text,
      ]);
    }
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-audiobook-test-'));
  const store = new AudiobookAudioStore(directory);
  const render = vi.fn(async (chapter: string, request: PlainTTSRequest) => ({
    data: Buffer.from('RIFF fixture ' + chapter + request.paragraphId),
    contentType: 'audio/wav',
    key: structuredIntegrityHash({ chapter, request }),
  }));
  const service = new AudiobookService(pool, 'owner', store, catalog, render, classifyPlainTTSFailure);
  return { directory, store, render, service, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

(harness ? describe : describe.skip)('durable ordinary audiobooks', () => {
  it('finishes pending deletion after a book is hidden and does not dispatch after shutdown', async () => {
    await withPostgresSchema(harness!, 'audiobook_cleanup', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        await f.store.put(job.id, 0, { data: Buffer.from('fixture'), contentType: 'audio/wav', key: 'fixture' });
        await pool.query("update saved_audiobooks set status='deleting' where id=$1", [job.id]);
        await pool.query('update library_books set deleted_at=now()');
        await f.service.tick();
        expect((await pool.query('select id from saved_audiobooks')).rows).toEqual([]);
        expect(await f.store.get(job.id, 0)).toBeUndefined();
        await pool.query('update library_books set deleted_at=null');
        await f.service.create(plan, plan.estimate.fingerprint, true);
        await f.service.stop();
        await f.service.tick();
        expect(f.render).not.toHaveBeenCalled();
        expect((await f.service.list('book'))[0].status).toBe('queued');
      } finally {
        await f.cleanup();
      }
    });
  });
  it('reuses a retained recording through ordinary playback after restart, and plays saved audio without its engine', async () => {
    await withPostgresSchema(harness!, 'audiobook_playback', async (pool) => {
      const f = await setup(pool);
      const synthesize = vi.fn(async () => ({
        audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer as ArrayBuffer,
        contentType: 'audio/wav',
      }));
      const provider = {
        providerId: 'local-endpoint',
        displayName: 'Fixture',
        supportsStreaming: false,
        supportsAudioCache: true,
        supportsPerCharacterVoice: false,
        listVoices: async () => [{ id: 'M1', label: 'Local', lang: 'ko' }],
        synthesize,
      } as TTSSynthesisProvider;
      const apps: ReturnType<typeof Fastify>[] = [];
      const open = async (enabled = true) => {
        const app = Fastify();
        apps.push(app);
        app.addHook('onRequest', async (request) => {
          request.principal = { userId: 'owner', role: 'admin', authMethod: 'legacy-token' };
        });
        const service = await registerPlainTTSRoutes(
          app,
          pool,
          { ...loadConfig({ DEFAULT_USER_ID: 'owner' }), dataDir: f.directory },
          {
            provider,
            savedAudiobooks: true,
            audiobookBackground: false,
            env: {
              TTS_PLAIN_ENABLED: enabled ? 'true' : 'false',
              TTS_PLAIN_MODEL_ID: 'fixture',
              TTS_PLAIN_MODEL_REVISION: 'model',
            },
          },
        );
        return { app, service: service! };
      };
      try {
        const first = await open();
        const plan = await first.service.plan('book', { ...settings, voiceId: 'M1' });
        const job = await first.service.create(plan, plan.estimate.fingerprint, false);
        await first.service.tick();
        expect(synthesize).toHaveBeenCalledTimes(1);
        await first.app.close();
        const second = await open();
        const input = { ...plan.items[0].request, rules: [] };
        const response = await second.app.inject({ method: 'POST', url: '/api/chapters/c1/tts/plain', payload: input });
        expect(response.statusCode).toBe(200);
        expect(synthesize).toHaveBeenCalledTimes(1);
        const offline = await open(false);
        expect((await offline.app.inject(`/api/audiobooks/${job.id}/audio/0`)).statusCode).toBe(200);
        expect(synthesize).toHaveBeenCalledTimes(1);
      } finally {
        for (const app of apps) await app.close();
        await f.cleanup();
      }
    });
  });
  it('renders selected chapters in source order with real batch reconstruction and stable one-speed synthesis', async () => {
    await withPostgresSchema(harness!, 'audiobook_batch', async (pool) => {
      const f = await setup(pool);
      const spoken: string[] = [];
      const provider: TTSSynthesisProvider = {
        providerId: 'local-endpoint',
        displayName: 'Fixture',
        supportsStreaming: false,
        supportsAudioCache: true,
        supportsPerCharacterVoice: false,
        listVoices: async () => [{ id: 'M1', label: 'Local', lang: 'ko' }],
        synthesize: async (input) => {
          spoken.push(input.text);
          expect(input.speed).toBe(1);
          return { audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer, contentType: 'audio/wav' };
        },
      };
      const app = Fastify();
      try {
        await pool.query(
          "update paragraph_search set text=chapter_id || '의 ' || paragraph_index || '번째 문장입니다.'",
        );
        const service = (await registerPlainTTSRoutes(
          app,
          pool,
          { ...loadConfig({ DEFAULT_USER_ID: 'owner' }), dataDir: f.directory },
          {
            provider,
            savedAudiobooks: true,
            audiobookBackground: false,
            env: { TTS_PLAIN_ENABLED: 'true', TTS_PLAIN_MODEL_ID: 'fixture', TTS_PLAIN_MODEL_REVISION: 'model' },
          },
        ))!;
        const plan = await service.plan('book', {
          ...settings,
          voiceId: 'M1',
          chunking: 'batch',
          batchCharacters: 700,
        });
        expect(plan.estimate).toMatchObject({ itemCount: 2, firstChapterTitle: 'First', lastChapterTitle: 'Second' });
        await service.create(plan, plan.estimate.fingerprint, false);
        await service.tick();
        await service.tick();
        expect(spoken).toEqual([
          'c1의 일번째 문장입니다.\n\nc1의 이번째 문장입니다.',
          'c2의 일번째 문장입니다.\n\nc2의 이번째 문장입니다.',
        ]);
        expect((await service.list('book'))[0]).toMatchObject({ status: 'completed', completedItems: 2 });
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
  it('retries known 429 failures on the same item and stops before dispatch when the quota is full', async () => {
    await withPostgresSchema(harness!, 'audiobook_limits', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        f.render.mockRejectedValueOnce(
          Object.assign(new Error('fixture rate limit'), { status: 429, retryAfterSeconds: 1 }),
        );
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        expect(f.render.mock.calls[0]).toEqual(f.render.mock.calls[1]);
        expect((await f.service.list('book'))[0]).toMatchObject({ completedItems: 1, status: 'queued' });
        await pool.query('update saved_audiobooks set bytes=$2 where id=$1', [job.id, AUDIOBOOK_QUOTA_BYTES]);
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        expect((await f.service.list('book'))[0]).toMatchObject({
          status: 'failed',
          error: expect.stringContaining('저장 공간'),
        });
      } finally {
        await f.cleanup();
      }
    });
  });
  it('plans owned ordered source without synthesis, requires paid consent, reuses the same plan, survives a fresh service and retains audio', async () => {
    await withPostgresSchema(harness!, 'audiobook_durable', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        expect(plan.settings.chapterIds).toEqual(['c1', 'c2']);
        expect(plan.estimate).toMatchObject({ chapterCount: 2, itemCount: 4, paid: true });
        expect(f.render).not.toHaveBeenCalled();
        await expect(f.service.create(plan, plan.estimate.fingerprint, false)).rejects.toThrow('API');
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        expect((await f.service.create(plan, plan.estimate.fingerprint, true)).id).toBe(job.id);
        await f.service.tick();
        const recreated = new AudiobookService(
          pool,
          'owner',
          new AudiobookAudioStore(f.directory),
          catalog,
          f.render,
          classifyPlainTTSFailure,
        );
        for (let i = 0; i < 3; i++) await recreated.tick();
        expect((await recreated.list('book'))[0]).toMatchObject({ status: 'completed', completedItems: 4 });
        expect(f.render).toHaveBeenCalledTimes(4);
        const audio = await recreated.audio(job.id, 0);
        expect(audio.data.toString()).toContain('c1');
        expect((await f.store.find(pool, 'owner', audio.key))?.data).toEqual(audio.data);
        expect(await f.store.find(pool, 'other', audio.key)).toBeUndefined();
        await recreated.progress(job.id, 2);
        expect((await recreated.list('book'))[0].playbackIndex).toBe(2);
        await pool.query("update library_books set active_content_revision_id='new'");
        expect(await f.store.find(pool, 'owner', audio.key)).toBeUndefined();
        // An explicitly saved recording remains playable even after source/engine changes.
        expect((await recreated.audio(job.id, 0)).data).toEqual(audio.data);
        expect(f.render).toHaveBeenCalledTimes(4);
        await recreated.remove(job.id);
        expect(await recreated.list('book')).toEqual([]);
        expect(await f.store.get(job.id, 0)).toBeUndefined();
      } finally {
        await f.cleanup();
      }
    });
  });
  it('pauses after the active item, fences a second runner, then resumes only missing items', async () => {
    await withPostgresSchema(harness!, 'audiobook_pause', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        let finish!: () => void;
        const gate = new Promise<void>((r) => {
          finish = r;
        });
        const original = f.render.getMockImplementation()!;
        let started!: () => void;
        const start = new Promise<void>((r) => {
          started = r;
        });
        f.render.mockImplementationOnce(async (...args) => {
          started();
          await gate;
          return original(...args);
        });
        const work = f.service.tick();
        await start;
        const second = new AudiobookService(pool, 'owner', f.store, catalog, f.render, classifyPlainTTSFailure);
        await second.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        expect((await f.service.control(job.id, 'pause')).status).toBe('pausing');
        await expect(f.service.remove(job.id)).rejects.toThrow('중단');
        finish();
        await work;
        expect((await f.service.list('book'))[0]).toMatchObject({ status: 'paused', completedItems: 1 });
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        await expect(f.service.control(job.id, 'resume')).rejects.toThrow('API');
        await f.service.control(job.id, 'resume', true);
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        expect(f.render.mock.calls[1][1].paragraphId).toBe('c1-2');
      } finally {
        await f.cleanup();
      }
    });
  });
  it('requires explicit recovery for interrupted/ambiguous paid requests and rejects stale source before dispatch', async () => {
    await withPostgresSchema(harness!, 'audiobook_recovery', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        await pool.query("update saved_audiobooks set status='running' where id=$1", [job.id]);
        await pool.query("update saved_audiobook_items set status='dispatching' where audiobook_id=$1 and ordinal=0", [
          job.id,
        ]);
        await f.service.tick();
        expect(f.render).not.toHaveBeenCalled();
        expect((await f.service.list('book'))[0]).toMatchObject({
          status: 'paused',
          error: expect.stringContaining('다시 발생'),
        });
        await f.service.control(job.id, 'resume', true);
        f.render.mockRejectedValueOnce(Object.assign(new Error('private provider response'), { status: 502 }));
        await f.service.tick();
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        expect((await f.service.list('book'))[0]).toMatchObject({
          status: 'failed',
          completedItems: 0,
          error: expect.not.stringContaining('private'),
        });
        await f.service.control(job.id, 'resume', true);
        await pool.query("update library_books set active_content_revision_id='new'");
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        expect((await f.service.list('book'))[0].error).toContain('본문');
      } finally {
        await f.cleanup();
      }
    });
  });
  it('enforces real HTTP account/role ownership and stored audio integrity', async () => {
    await withPostgresSchema(harness!, 'audiobook_routes', async (pool) => {
      const f = await setup(pool);
      const app = Fastify();
      let userId = 'owner';
      let role: 'admin' | 'member' = 'admin';
      app.addHook('onRequest', async (request) => {
        request.principal = { userId, role, authMethod: 'session', sessionContext: 'test' };
      });
      try {
        await registerAudiobookRoutes(app, pool, { defaultUserId: 'owner' } as ServerConfig, {
          audioStore: f.store,
          catalog,
          render: f.render,
          rules: parsePlainTTSRules,
          failure: classifyPlainTTSFailure,
          background: false,
        });
        const estimate = await app.inject({
          method: 'POST',
          url: '/api/books/book/audiobooks/estimate',
          payload: settings,
        });
        expect(estimate.statusCode).toBe(200);
        const made = await app.inject({
          method: 'POST',
          url: '/api/books/book/audiobooks',
          payload: { ...settings, fingerprint: estimate.json().fingerprint, confirmPaid: true },
        });
        expect(made.statusCode).toBe(200);
        const id = made.json().id;
        await f.service.tick();
        expect((await app.inject(`/api/audiobooks/${id}/audio/0`)).statusCode).toBe(200);
        userId = 'other';
        expect((await app.inject(`/api/audiobooks/${id}/audio/0`)).statusCode).toBe(403);
        userId = 'owner';
        role = 'member';
        expect((await app.inject('/api/books/book/audiobooks')).statusCode).toBe(403);
        role = 'admin';
        await writeFile(path.join(f.directory, id, '0.audio'), 'corrupt');
        expect((await app.inject(`/api/audiobooks/${id}/audio/0`)).statusCode).toBe(410);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/books/book/audiobooks/estimate',
              payload: { ...settings, chapterIds: ['foreign'] },
            })
          ).statusCode,
        ).toBe(409);
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
});
