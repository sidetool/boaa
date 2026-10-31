import { GeminiAudioResponseError } from '../providers/gemini-audio-response.js';
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
async function setup(pool: pg.Pool, concurrency: 1 | 2 = 1) {
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
  await pool.query(await readFile(new URL('../db/migrations/0067_audiobook_retry.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../db/migrations/0068_speaker_generation.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../db/migrations/0069_voice_library.sql', import.meta.url), 'utf8'));
  await pool.query(
    await readFile(new URL('../db/migrations/0070_audiobook_content_blocks.sql', import.meta.url), 'utf8'),
  );
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
  const service = new AudiobookService(
    pool,
    'owner',
    store,
    catalog,
    render,
    classifyPlainTTSFailure,
    undefined,
    async () => concurrency,
  );
  return { directory, store, render, service, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

(harness ? describe : describe.skip)('durable ordinary audiobooks', () => {
  it('skips confirmed content blocks only after consent, persists omissions and never resends them', async () => {
    await withPostgresSchema(harness!, 'audio_policy_skip', async (pool) => {
      const f = await setup(pool, 2);
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.principal = { userId: 'owner', role: 'admin', authMethod: 'session', sessionContext: 'test' };
      });
      await registerAudiobookRoutes(app, pool, { defaultUserId: 'owner' } as ServerConfig, {
        audioStore: f.store,
        catalog,
        render: f.render,
        rules: parsePlainTTSRules,
        failure: classifyPlainTTSFailure,
        background: false,
      });
      const original = f.render.getMockImplementation()!;
      f.render.mockImplementation(async (...args) => {
        if (args[1].paragraphId.endsWith('-1')) throw new GeminiAudioResponseError('provider_finish_reason', 'SAFETY');
        return original(...args);
      });
      try {
        await expect(f.service.plan('book', { ...settings, skipBlockedAudio: true })).rejects.toThrow();
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        await f.service.tick();
        expect((await f.service.list('book'))[0]).toMatchObject({
          status: 'failed',
          completedItems: 1,
          blockedItems: 1,
          skippedItems: 0,
          blockedAudio: [{ ordinal: 0, chapterTitle: 'First', reason: 'SAFETY' }],
        });
        await expect(f.service.control(job.id, 'resume', true)).rejects.toThrow('건너뛰기');
        await expect(f.service.control(job.id, 'skip-blocked', false)).rejects.toThrow('비용');
        const other = new AudiobookService(pool, 'other', f.store, catalog, f.render, classifyPlainTTSFailure);
        await expect(other.control(job.id, 'skip-blocked', true)).rejects.toThrow();
        expect(f.render).toHaveBeenCalledTimes(2);
        const skippedResponse = await app.inject({
          method: 'POST',
          url: `/api/audiobooks/${job.id}/control`,
          payload: { action: 'skip-blocked', confirmPaid: true },
        });
        expect(skippedResponse.statusCode).toBe(200);
        // A new service process honors the saved decision; current and later refusals are separate from audio.
        const restarted = new AudiobookService(
          pool,
          'owner',
          f.store,
          catalog,
          f.render,
          classifyPlainTTSFailure,
          undefined,
          async () => 2,
        );
        await restarted.tick();
        await restarted.tick();
        const complete = (await restarted.list('book'))[0];
        expect(complete).toMatchObject({
          status: 'completed',
          completedItems: 2,
          itemCount: 4,
          blockedItems: 0,
          skippedItems: 2,
          skipBlockedAudio: true,
        });
        expect(complete.skippedAudio?.map((i) => i.ordinal)).toEqual([0, 2]);
        expect(f.render).toHaveBeenCalledTimes(4);
        expect(await f.store.get(job.id, 0)).toBeUndefined();
        await expect(restarted.resolve(job.id, 0, true)).rejects.toThrow('건너뛴');
        const staleReader = await app.inject({
          method: 'POST',
          url: `/api/audiobooks/${job.id}/resolve/0`,
          payload: {},
        });
        expect(staleReader.statusCode).toBe(410);
        expect(staleReader.json().code).toBe('tts_audio_skipped');
        await expect(restarted.audio(job.id, 0)).rejects.toThrow();
        expect(f.render).toHaveBeenCalledTimes(4);
        const reader = await restarted.reader('book', 'c1', { id: job.id });
        expect(reader).toMatchObject({ skippedItems: 1 });
        expect(reader?.items[0].playable.preparedAudio).toMatchObject({ ready: false, skipped: true });
        expect(reader?.items[1].playable.preparedAudio).toMatchObject({ ready: true, skipped: false });
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
  it('does not skip timeout, quota or malformed audio even with content skipping enabled', async () => {
    await withPostgresSchema(harness!, 'audio_policy_not_transport', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        await pool.query(
          "update saved_audiobooks set settings=jsonb_set(settings,'{skipBlockedAudio}','true') where id=$1",
          [job.id],
        );
        for (const error of [
          new GeminiAudioResponseError('wav_length_mismatch'),
          new DOMException('timeout', 'TimeoutError'),
          { status: 429 },
        ]) {
          f.render.mockRejectedValue(error);
          await f.service.tick();
          const item = (await f.service.list('book'))[0];
          expect(item).toMatchObject({ blockedItems: 0, skippedItems: 0, completedItems: 0 });
          await expect(f.service.control(job.id, 'skip-blocked', true)).rejects.toThrow();
          await pool.query("update saved_audiobooks set status='queued',retry_at=null where id=$1", [job.id]);
        }
      } finally {
        await f.cleanup();
      }
    });
  });

  it('runs at most two, saves out-of-order results, shares playback and preserves the original anchors', async () => {
    await withPostgresSchema(harness!, 'prepared_parallel', async (pool) => {
      const f = await setup(pool, 2);
      const release = new Map<string, () => void>();
      const original = f.render.getMockImplementation()!;
      f.render.mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => release.set(args[1].paragraphId, resolve));
        return original(...args);
      });
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        const turn = f.service.tick();
        await vi.waitFor(() => expect(release.size).toBe(2));
        const secondRunner = new AudiobookService(pool, 'owner', f.store, catalog, f.render, classifyPlainTTSFailure);
        expect(await secondRunner.tick()).toBe(false);
        const listener = f.service.resolve(job.id, 1);
        release.get('c1-2')!();
        await listener;
        expect(f.render).toHaveBeenCalledTimes(2);
        expect((await f.service.list('book'))[0].completedItems).toBe(1);
        const anchors = await f.service.reader('book', 'c1', { id: job.id });
        expect(anchors?.items.map((i) => [i.ordinal, i.paragraphIndex, i.playable.preparedAudio?.ready])).toEqual([
          [0, 0, false],
          [1, 1, true],
        ]);
        release.get('c1-1')!();
        expect(await turn).toBe(true);
        f.render.mockImplementation(original);
        expect(await f.service.tick()).toBe(true);
        expect((await f.service.list('book'))[0]).toMatchObject({ status: 'completed', completedItems: 4 });
        expect(f.render.mock.calls.map((c) => c[1].paragraphId).sort()).toEqual(['c1-1', 'c1-2', 'c2-1', 'c2-2']);
        await f.service.resolve(job.id, 1);
        expect(f.render).toHaveBeenCalledTimes(4);
        expect(await f.service.tick()).toBe(false);
      } finally {
        for (const done of release.values()) done();
        await f.service.stop();
        await f.cleanup();
      }
    });
  });
  it.each(['pause', 'shutdown', '429', 'timeout-and-429', 'quota'] as const)(
    'drains concurrent work safely on %s',
    async (action) => {
      await withPostgresSchema(harness!, 'prepared_parallel_control', async (pool) => {
        const f = await setup(pool, 2);
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const original = f.render.getMockImplementation()!;
        f.render.mockImplementation(async (...args) => {
          await gate;
          if (action === 'timeout-and-429' && args[1].paragraphId === 'c1-1')
            throw new DOMException('deadline', 'TimeoutError');
          if (action === 'timeout-and-429' || (action === '429' && args[1].paragraphId === 'c1-1'))
            throw Object.assign(new Error('limited'), { status: 429, retryAfterSeconds: 600 });
          return original(...args);
        });
        try {
          const plan = await f.service.plan('book', settings);
          const job = await f.service.create(plan, plan.estimate.fingerprint, true);
          if (action === 'quota')
            await pool.query('update saved_audiobooks set bytes=$2 where id=$1', [
              job.id,
              AUDIOBOOK_QUOTA_BYTES - 24 * 1024 * 1024,
            ]);
          const work = f.service.tick();
          await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(action === 'quota' ? 1 : 2));
          let stopped: Promise<unknown> | undefined;
          if (action === 'pause' || action === 'shutdown') {
            stopped = action === 'shutdown' ? f.service.stop() : f.service.control(job.id, 'pause');
            await vi.waitFor(async () => expect((await f.service.list('book'))[0].status).toBe('pausing'));
          }
          if (action === 'quota') {
            // Both writers have been admitted to the pool; the rejected writer releases its connection.
            await vi.waitFor(() => expect(pool.totalCount - pool.idleCount).toBe(2));
            expect(f.render).toHaveBeenCalledTimes(1);
          }
          finish();
          await Promise.all([work, stopped]);
          const saved = (await f.service.list('book'))[0];
          if (action === 'pause' || action === 'shutdown')
            expect(saved).toMatchObject({ status: 'paused', completedItems: 2 });
          else if (action === 'quota')
            expect(saved).toMatchObject({
              status: 'failed',
              completedItems: 1,
              error: expect.stringContaining('저장 공간'),
            });
          else if (action === 'timeout-and-429') expect(saved).toMatchObject({ status: 'failed', completedItems: 0 });
          else expect(saved).toMatchObject({ status: 'queued', completedItems: 1 });
          expect(await f.service.tick()).toBe(false);
          expect(f.render).toHaveBeenCalledTimes(action === 'quota' ? 1 : 2);
          if (action === '429') {
            const retry = (
              await pool.query('select extract(epoch from retry_at-now()) seconds from saved_audiobooks where id=$1', [
                job.id,
              ])
            ).rows[0];
            expect(Number(retry.seconds)).toBeGreaterThan(590);
            await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
            f.render.mockImplementation(original);
            expect(await f.service.tick()).toBe(true);
            expect(f.render).toHaveBeenCalledTimes(3);
            expect(f.render.mock.calls[2][1].paragraphId).toBe('c1-1');
            await f.service.tick();
            expect(f.render).toHaveBeenCalledTimes(5);
            expect((await f.service.list('book'))[0]).toMatchObject({ status: 'completed', completedItems: 4 });
          }
        } finally {
          finish();
          await f.service.stop();
          await f.cleanup();
        }
      });
    },
  );
  it('shares foreground and background items, counts out-of-order completion and preserves source anchors', async () => {
    await withPostgresSchema(harness!, 'prepared_shared', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', { ...settings, chunking: 'batch', batchCharacters: 700 });
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const original = f.render.getMockImplementation()!;
        f.render.mockImplementationOnce(async (...args) => {
          await held;
          return original(...args);
        });
        const first = f.service.resolve(job.id, 1);
        const joined = f.service.resolve(job.id, 1);
        await vi.waitFor(() => expect(f.render).toHaveBeenCalledTimes(1));
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        await expect(f.service.remove(job.id)).rejects.toMatchObject({ statusCode: 409 });
        finish();
        expect((await first).data).toEqual((await joined).data);
        expect((await f.service.list('book'))[0]).toMatchObject({ completedItems: 1, status: 'queued' });
        expect((await f.service.audio(job.id, 1)).data.length).toBeGreaterThan(0);
        await expect(f.service.audio(job.id, 0)).rejects.toMatchObject({ statusCode: 404 });
        await f.service.progress(job.id, 1);
        const anchors = await f.service.reader('book', 'c2', { id: job.id });
        expect(anchors?.items).toHaveLength(1);
        expect(anchors?.items[0]).toMatchObject({
          ordinal: 1,
          paragraphIndex: 0,
          playable: { preparedAudio: { id: job.id, ordinal: 1, ready: true } },
        });
        expect(anchors?.items[0].playable.plainBatchPositions?.map((p) => p.paragraphIndex)).toEqual([0, 1]);
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(2);
        expect((await f.service.list('book'))[0]).toMatchObject({ completedItems: 2, status: 'completed' });
        await pool.query("update library_books set active_content_revision_id='new-revision'");
        expect(await f.service.reader('book', 'c2', { id: job.id })).toBeUndefined();
        await expect(f.service.resolve(job.id, 1)).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await f.cleanup();
      }
    });
  });
  it('does not retry ambiguous foreground failures in the background and allows explicit retry', async () => {
    await withPostgresSchema(harness!, 'prepared_failure', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        f.render.mockRejectedValueOnce(new Error('provider disconnected'));
        await expect(f.service.resolve(job.id, 0)).rejects.toThrow('provider disconnected');
        expect((await f.service.list('book'))[0].status).toBe('failed');
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        await f.service.resolve(job.id, 0);
        expect(f.render).toHaveBeenCalledTimes(2);
        expect((await f.service.list('book'))[0].completedItems).toBe(1);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('pins only the selected model and serves ready audio with no engine through the reader routes', async () => {
    await withPostgresSchema(harness!, 'prepared_models', async (pool) => {
      const f = await setup(pool);
      const app = Fastify();
      const synthesize = vi.fn(async () => ({
        audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer,
        contentType: 'audio/wav',
      }));
      const provider = {
        providerId: 'local-endpoint',
        displayName: 'Fixture',
        supportsStreaming: false,
        supportsAudioCache: true,
        supportsPerCharacterVoice: false,
        listVoices: async () => [{ id: 'voice', label: 'Recorded voice', lang: 'ko' }],
        synthesize,
      } as TTSSynthesisProvider;
      const deadline = vi.spyOn(AbortSignal, 'timeout');
      let model = 'stable';
      let revision = 'old';
      let extra = false;
      let offline = false;
      app.addHook('onRequest', async (request) => {
        request.principal = { userId: 'owner', role: 'admin', authMethod: 'legacy-token' };
      });
      try {
        const service = (await registerPlainTTSRoutes(
          app,
          pool,
          { ...loadConfig({ DEFAULT_USER_ID: 'owner' }), dataDir: f.directory },
          {
            provider,
            savedAudiobooks: true,
            audiobookBackground: false,
            env: {},
            sources: async () =>
              offline
                ? []
                : [
                    ...(extra
                      ? [
                          {
                            id: 'other',
                            name: 'Other model',
                            modelId: 'unrelated',
                            revision: 'new',
                            paid: false,
                            createProvider: async () => provider,
                          },
                        ]
                      : []),
                    {
                      id: 'fixture',
                      name: 'Fixture',
                      modelId: 'same-model',
                      revision,
                      synthesisRevision: model,
                      paid: false,
                      createProvider: async () => provider,
                    },
                  ],
          },
        ))!;
        const voices = (await app.inject('/api/tts/plain/voices')).json();
        const plan = await service.plan('book', { ...settings, modelRevision: voices.revision });
        const job = await service.create(plan, plan.estimate.fingerprint, false);
        expect((await service.get(job.id)).settings.model).toMatchObject({
          providerId: 'fixture',
          modelId: 'same-model',
          revision: 'stable',
        });
        await service.tick();
        expect(deadline).toHaveBeenCalledWith(120_000);
        revision = 'unrelated-settings-timestamp';
        extra = true;
        await service.tick();
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect((await service.get(job.id)).completed_items).toBe(2);
        model = 'changed-model';
        await service.tick();
        expect((await service.list('book'))[0]).toMatchObject({ status: 'failed', completedItems: 2 });
        expect(synthesize).toHaveBeenCalledTimes(2);
        offline = true;
        const reader = await app.inject(`/api/books/book/audiobooks/reader?chapterId=c1&id=${job.id}`);
        expect(reader.statusCode).toBe(200);
        expect(reader.json().plan.items[0].playable.preparedAudio.ready).toBe(true);
        const audio = await app.inject({ method: 'POST', url: `/api/audiobooks/${job.id}/resolve/0`, payload: {} });
        expect(audio.statusCode).toBe(200);
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect((await app.inject(`/api/books/other/audiobooks/reader?chapterId=c1&id=${job.id}`)).json()).toEqual({});
      } finally {
        deadline.mockRestore();
        await app.close();
        await f.cleanup();
      }
    });
  });
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
      const open = async (enabled = true, extra = false) => {
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
            sources: extra
              ? async () => [
                  {
                    id: 'other',
                    name: 'Unrelated model',
                    modelId: 'unrelated',
                    revision: 'unrelated',
                    paid: false,
                    createProvider: async () => provider,
                  },
                ]
              : undefined,
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
        // A deployed v1 plan has no selected-model identity; prove migration using its recorded audio key.
        await pool.query("update saved_audiobooks set settings=settings-'model' where id=$1", [job.id]);
        await first.app.close();
        const second = await open(true, true);
        const input = { ...plan.items[0].request, voiceRevision: 'model', rules: [] };
        const response = await second.app.inject({ method: 'POST', url: '/api/chapters/c1/tts/plain', payload: input });
        expect(response.statusCode).toBe(200);
        expect(synthesize).toHaveBeenCalledTimes(1);
        await second.service.tick();
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect((await second.service.get(job.id)).settings.model).toMatchObject({
          providerId: 'supertonic',
          revision: 'model',
        });
        const offline = await open(false);
        expect((await offline.app.inject(`/api/audiobooks/${job.id}/audio/0`)).statusCode).toBe(200);
        expect(synthesize).toHaveBeenCalledTimes(2);
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
          Object.assign(new Error('fixture rate limit'), {
            status: 429,
            retryAfterSeconds: 1,
            requestStage: 'voice_design',
          }),
        );
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        expect((await f.service.list('book'))[0]).toMatchObject({ completedItems: 0, status: 'queued' });
        expect((await f.service.list('book'))[0].error).toContain('목소리 제작 요청 제한으로 대기 중');
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
        await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
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

  it('stops automatic creation retries when Google confirms the voice creation quota is zero', async () => {
    await withPostgresSchema(harness!, 'voice_quota_zero', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        f.render.mockRejectedValue(
          Object.assign(new Error('limited'), {
            status: 429,
            requestStage: 'voice_design',
            voiceCreationQuota: 0,
          }),
        );
        await f.service.tick();
        expect(await f.service.get(job.id)).toMatchObject({
          status: 'failed',
          retry_at: null,
          error_message: expect.stringContaining('제작 한도가 0'),
        });
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(1);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('persists repeated rate-limit waits across fresh services, honors retry-after and stops on user pause', async () => {
    await withPostgresSchema(harness!, 'audiobook_cooldown', async (pool) => {
      const f = await setup(pool);
      try {
        const plan = await f.service.plan('book', settings);
        const job = await f.service.create(plan, plan.estimate.fingerprint, true);
        f.render.mockRejectedValue(Object.assign(new Error('limited'), { status: 429, retryAfterSeconds: 600 }));
        for (let attempt = 1; attempt <= 5; attempt++) {
          const service = new AudiobookService(pool, 'owner', f.store, catalog, f.render, classifyPlainTTSFailure);
          await service.tick();
          const row = (
            await pool.query(
              'select status,rate_limit_attempts,extract(epoch from retry_at-now()) as wait from saved_audiobooks where id=$1',
              [job.id],
            )
          ).rows[0];
          expect(row.status).toBe('queued');
          expect(row.rate_limit_attempts).toBe(attempt);
          expect(Number(row.wait)).toBeGreaterThan(590);
          await service.tick();
          expect(f.render).toHaveBeenCalledTimes(attempt);
          await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
        }
        await f.service.control(job.id, 'pause');
        await f.service.tick();
        expect(f.render).toHaveBeenCalledTimes(5);
        expect((await f.service.list('book'))[0].status).toBe('paused');
        await f.service.control(job.id, 'resume', true);
        f.render.mockResolvedValue({ data: Buffer.from('RIFF'), contentType: 'audio/wav', key: 'fixture' });
        await f.service.tick();
        const row = (
          await pool.query('select retry_at,rate_limit_attempts,completed_items from saved_audiobooks where id=$1', [
            job.id,
          ])
        ).rows[0];
        expect(row).toMatchObject({ retry_at: null, rate_limit_attempts: 0, completed_items: 1 });
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
