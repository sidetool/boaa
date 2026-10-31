import { TransientTTSError } from '../providers/tts-transient-error.js';
import { GeminiAudioResponseError } from '../providers/gemini-audio-response.js';
import { preparedNarrationSession } from '../../../../src/providers/prepared-narration';
import { runTTSPlaybackSession } from '../../../../src/providers/tts-playback-session-runner';
import { VoiceLibraryStore } from './voice-library-store';
import type { SpeakerVoiceCasting } from './speaker-voice-casting';
import type { PlainTTSVoices } from '../../../../src/providers/plain-tts';
import { speakerPlan, loadSpeakerChapter } from './speaker-generation-plan';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import Fastify from 'fastify';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from './id-v2-migration/postgres-integration-harness.js';
import { AudiobookService } from './audiobook-service.js';
import { AudiobookAudioStore } from './audiobook-audio.js';
import { SpeakerGenerationService } from './speaker-generation-service.js';
import { SpeakerEngineStore } from '../providers/speaker-engine-store.js';
import { connectionError } from '../providers/tts-connection-config';
import { SpeakerEngineTransport } from '../providers/speaker-engine-transport.js';
import { classifyPlainTTSFailure, parsePlainTTSRules } from '../routes/ai/plain-tts-routes.js';
import { registerSpeakerGenerationRoutes } from '../routes/ai/speaker-generation-routes.js';
import { loadConfig } from '../config.js';
import { step, attributionStep, ENGINE_VERSION } from '../../../speaker-engine/src/engine';
import { attribution, identity } from '../../../speaker-engine/src/test-fixtures';
import { prepare } from '../../../speaker-engine/src/engine';
import {
  NEUTRAL_PERFORMANCE,
  PERFORMANCE_INSTRUCTION,
  performanceStyle,
  type SpeakerPerformance,
} from '../../../../src/providers/tts-performance';
import {
  SPEAKER_ENGINE_PROTOCOL,
  type SpeakerEngineStep,
  type SpeakerEngineResult,
} from '../../../../src/providers/speaker-engine-protocol';
import { attributionKey } from './speaker-attribution-preparation';
import { planSpeakerRevoice } from './speaker-revoice-plan';
import type { SpeakerGenerationInput, SpeakerRevoiceInput } from '../../../../src/providers/speaker-generation';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
async function setup(pool: pg.Pool, concurrency: 1 | 2 = 1, chapterIds = ['c1', 'c2']) {
  // Match production: runner + analysis session fences + two audio sessions need query headroom.
  pool.options.max = 10;
  await pool.query(`create table users(id text primary key);create table library_books(id text primary key,user_id text,title text,format text,language text,active_content_revision_id text,deleted_at timestamptz);
 create table chapters(id text primary key,book_id text,title text,chapter_index int);create table paragraph_search(book_id text,chapter_id text,paragraph_id text,paragraph_index int,paragraph jsonb,text text);
 create table self_host_accounts(user_id text,role text,status text);insert into users values('owner'),('other');insert into library_books values('book','owner','Fixture','txt','ko','rev',null);insert into self_host_accounts values('owner','admin','active');
 `);
  for (const name of [
    '0065_saved_audiobooks.sql',
    '0067_audiobook_retry.sql',
    '0068_speaker_generation.sql',
    '0069_voice_library.sql',
    '0070_audiobook_content_blocks.sql',
    '0071_audiobook_transient_retries.sql',
  ])
    await pool.query(await readFile(new URL('../db/migrations/' + name, import.meta.url), 'utf8'));
  for (const [index, id] of chapterIds.entries()) {
    await pool.query("insert into chapters values($1,'book',$2,$3)", [
      id,
      ['First', 'Second', 'Third', 'Fourth'][index],
      index + 1,
    ]);
    const p = {
      id: id + '-p',
      novelId: 'book',
      chapterId: id,
      index: 1,
      text: '민아가 말했다. “안녕 🌙.” 잠시 쉬었다.',
    };
    await pool.query('insert into paragraph_search values($1,$2,$3,1,$4,$5)', ['book', id, p.id, p, p.text]);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-speaker-test-'));
  const config = { ...loadConfig({ DEFAULT_USER_ID: 'owner' }), dataDir: directory };
  const catalog = vi.fn(async (): Promise<PlainTTSVoices> => ({
    available: true,
    revision: 'catalog',
    voices: ['n', 'a', 'b'].map((id) => ({
      id,
      label: id,
      lang: 'ko',
      model: { providerId: 'fixture', modelId: 'same', revision: 'stable' },
      paid: id === 'b',
      instructionsSupported: id === 'b',
    })),
  }));
  const audio = new AudiobookService(
    pool,
    'owner',
    new AudiobookAudioStore(directory),
    catalog,
    async () => {
      throw Error('ordinary synthesis forbidden');
    },
    classifyPlainTTSFailure,
    undefined,
    async () => concurrency,
  );
  type ModelContext = { input: SpeakerEngineStep; request: Extract<SpeakerEngineResult, { kind: 'request' }> };
  const contexts = new Map<string, ModelContext>();
  const modelCalls: ModelContext[] = [];
  let attributionPreparation = true;
  let failAccept = false;
  let limited = false;
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const address = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: address, headers: new Headers(init?.headers), body });
    if (address.endsWith('/v1/capabilities'))
      return Response.json({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        engineVersion: ENGINE_VERSION,
        attributionPreparation,
        performanceAnnotations: true,
      });
    if (address.endsWith('/v1/step') || address.endsWith('/v1/attribution')) {
      if (failAccept && body.response) {
        failAccept = false;
        return new Response('temporary', { status: 503 });
      }
      const out = address.endsWith('/v1/attribution') ? attributionStep(body) : step(body);
      if (out.kind === 'request') contexts.set(out.prompt, { input: body, request: out });
      return Response.json(out);
    }
    if (address.endsWith('/chat/completions')) {
      const context = contexts.get(body.messages.at(-1).content);
      if (!context) throw Error('missing model context');
      modelCalls.push(context);
      const { input: last, request } = context;
      if (limited) {
        limited = false;
        return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
      }
      const previous = (last.ledger as { entries?: { workSpeakerId: string }[] } | undefined)?.entries?.[0]
        ?.workSpeakerId;
      const base = attribution(last.source);
      const wire =
        request.stage === 'attribution'
          ? {
              ...base,
              ...((request.checkpoint as { autoActing?: boolean }).autoActing
                ? {
                    performance: prepare(last.source).input.targets.map((target) => ({
                      id: target.targetId,
                      acting: ACTING_FIXTURE,
                    })),
                  }
                : {}),
            }
          : identity(request, previous);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(wire) } }] });
    }
    throw Error('unexpected network');
  });
  const engines = new SpeakerEngineStore(
    pool,
    config,
    {},
    new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] }),
  );
  const engine = await engines.save({
    name: 'Fixture',
    engineUrl: 'http://engine.test',
    engineToken: 'fixture-engine-token-12345678',
    protocol: 'openai',
    url: 'http://model.test/v1',
    apiKey: 'fixture-model-secret',
    modelId: 'fixture',
    maxOutputTokens: 24576,
    paid: true,
    enabled: true,
  });
  const synthesize = vi.fn(
    async (
      text: string,
      voiceId: string,
      _model: unknown,
      key: string,
      _regenerate = false,
      instructions?: string,
    ) => ({
      data: Buffer.from(text + '|' + voiceId + (instructions ? '|' + instructions : '')),
      contentType: 'audio/wav',
      key,
    }),
  );
  const service = new SpeakerGenerationService(pool, 'owner', engines, audio, catalog, synthesize);
  const input: SpeakerGenerationInput = {
    chapterIds: [...chapterIds],
    engineId: engine.id,
    narratorVoiceId: 'n',
    characterVoiceIds: ['a'],
    rules: [],
    footnotePlayback: 'skip',
  };
  const create = async (v = input) => {
    const e = await service.estimate('book', v);
    return service.create('book', v, e.fingerprint, true);
  };
  const until = async (predicate: () => Promise<boolean>) => {
    for (let n = 0; n < 35; n++) {
      if (await predicate()) return;
      await audio.tick();
    }
    throw Error(JSON.stringify(await service.list('book')));
  };
  return {
    pool,
    config,
    audio,
    engines,
    engine,
    service,
    catalog,
    synthesize,
    requests,
    fetchImpl,
    modelCalls,
    context: (request: Extract<SpeakerEngineResult, { kind: 'request' }>) => {
      const context = contexts.get(request.prompt);
      if (!context) throw Error('missing model context');
      return context;
    },
    setCapability: (value: boolean) => {
      attributionPreparation = value;
    },
    input,
    create,
    until,
    setFail: () => {
      failAccept = true;
    },
    setLimit: () => {
      limited = true;
    },
    cleanup: async () => {
      await audio.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
(harness ? describe : describe.skip)('speaker background generation with real preset35 and PostgreSQL', () => {
  it('automatically continues cast audio after a transient provider outage without manual analysis resume', async () => {
    await withPostgresSchema(harness!, 'cast_transient_retry', async (pool) => {
      const f = await setup(pool, 2);
      f.synthesize.mockRejectedValueOnce(new TransientTTSError('unavailable', 503, 60));
      try {
        const job = await f.create();
        await f.until(async () => !!(await f.service.list('book'))[0].retryAt);
        const waiting = (await f.service.list('book'))[0];
        expect(waiting.status).toBe('queued');
        expect(waiting.error).toContain('음성 서비스 연결을 기다리는 중');
        const calls = f.synthesize.mock.calls.length;
        expect(await f.audio.tick()).toBe(false);
        expect(f.synthesize).toHaveBeenCalledTimes(calls);
        await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        const done = (await f.service.list('book'))[0];
        expect(done.completedItems).toBe(done.itemCount);
        expect(done.skippedItems).toBe(0);
        expect(done.readyChapterIds.sort()).toEqual(['c1', 'c2']);
      } finally {
        await f.cleanup();
      }
    });
  });

  it('preserves speaker analysis and exposes omitted ranges when continuing content-blocked audio', async () => {
    await withPostgresSchema(harness!, 'speaker_policy_skip', async (pool) => {
      const f = await setup(pool, 2);
      const synth = f.synthesize.getMockImplementation()!;
      let blocked = false;
      f.synthesize.mockImplementation(async (...args) => {
        if (!blocked) {
          blocked = true;
          throw new GeminiAudioResponseError('provider_finish_reason', 'SAFETY');
        }
        return synth(...args);
      });
      try {
        const job = await f.create();
        await f.until(async () => (await f.audio.get(job.id)).status === 'failed');
        const failed = (await f.service.list('book'))[0];
        expect(failed.blockedItems).toBe(1);
        await expect(f.audio.control(job.id, 'resume', true)).rejects.toThrow('건너뛰기');
        await f.audio.control(job.id, 'skip-blocked', true);
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        const done = (await f.service.list('book'))[0];
        expect(done).toMatchObject({ blockedItems: 0, skippedItems: 1, skipBlockedAudio: true });
        expect(done.completedItems + done.skippedItems!).toBe(done.itemCount);
        expect(done.readyChapterIds.sort()).toEqual(['c1', 'c2']);
        const reader = await f.service.reader(job.id, 'c1');
        expect(reader.skippedItems).toBe(1);
        expect(reader.items.filter((i) => i.playable.preparedAudio?.skipped)).toHaveLength(1);
      } finally {
        await f.cleanup();
      }
    });
  });

  it('does not advertise partial acting chapters, prefers a complete recording and keeps preparation waits out of job failure', async () => {
    await withPostgresSchema(harness!, 'speaker_ready_chapters', async (pool) => {
      const f = await setup(pool);
      try {
        const catalog = await f.catalog();
        f.catalog.mockResolvedValue({
          ...catalog,
          voices: catalog.voices.map((v) => ({ ...v, autoActingSupported: true })),
        });
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const originalAudio = await f.audio.audio(original.id, 0);
        expect((await f.service.list('book'))[0].readyChapterIds.sort()).toEqual(['c1', 'c2']);
        // The same cached speaker analysis predates acting annotations, as on existing works.
        const next = await f.create({ ...f.input, autoActing: true });
        await f.until(
          async () =>
            (await pool.query('select 1 from saved_audiobook_items where audiobook_id=$1 limit 1', [next.id])).rows
              .length > 0,
        );
        const items = (
          await pool.query('select ordinal,request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
            next.id,
          ])
        ).rows;
        const eligible = items.find((i) => i.request.cast.performance);
        const pending = items.find((i) => !i.request.cast.performance);
        expect(eligible).toBeDefined();
        expect(pending).toBeDefined();
        await f.audio.resolve(next.id, eligible.ordinal);
        expect((await f.service.list('book')).find((j) => j.id === next.id)?.readyChapterIds).toEqual([]);
        expect((await f.audio.reader('book', 'c1', { voiceId: 'n' }))?.id).toBe(original.id);
        // Explicitly choosing a new voice must not silently switch back to an older recording.
        await expect(f.audio.reader('book', 'c1', { id: next.id })).rejects.toMatchObject({ statusCode: 425 });
        await pool.query("update saved_audiobooks set status='running' where id=$1", [next.id]);
        const calls = f.synthesize.mock.calls.length;
        await expect(f.audio.resolve(next.id, pending.ordinal)).rejects.toMatchObject({ statusCode: 425 });
        expect((await f.audio.get(next.id)).status).toBe('running');
        expect(f.synthesize).toHaveBeenCalledTimes(calls);
        expect(
          (
            await pool.query('select status from saved_audiobook_items where audiobook_id=$1 and ordinal=$2', [
              next.id,
              pending.ordinal,
            ])
          ).rows[0].status,
        ).toBe('pending');
        expect(await f.audio.audio(original.id, 0)).toEqual(originalAudio);
      } finally {
        await f.cleanup();
      }
    });
  });
  it.each(['complete', 'pause', 'audio-limit'] as const)(
    'overlaps committed audio with a held next-chapter model request: %s',
    async (ending) => {
      await withPostgresSchema(harness!, 'speaker_audio_overlap', async (pool) => {
        const f = await setup(pool, 2);
        const entered = gate(),
          held = gate(),
          audioEntered = gate(),
          audioHeld = gate();
        let pending: Promise<boolean> | undefined;
        let activeAudio = 0,
          peakAudio = 0;
        let modelPending = false;
        const generateOriginal = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi
          .spyOn(f.engines.transport, 'generate')
          .mockImplementation(async (engine, request, signal) => {
            if (f.context(request).input.source.chapter.id === 'c2') {
              modelPending = true;
              entered.resolve();
              await held.promise;
            }
            return generateOriginal(engine, request, signal);
          });
        const originalAudio = f.synthesize.getMockImplementation()!;
        f.synthesize.mockImplementation(async (...args) => {
          activeAudio++;
          peakAudio = Math.max(peakAudio, activeAudio);
          try {
            // Hold narration only once the next chapter's paid analysis is pending.
            if (modelPending && blocked) {
              audioEntered.resolve();
              await audioHeld.promise;
              if (ending === 'audio-limit')
                throw Object.assign(connectionError('limited', 429), { retryAfterSeconds: 17 });
            }
            return await originalAudio(...args);
          } finally {
            activeAudio--;
          }
        });
        let blocked = false;
        try {
          for (let i = 2; i <= 22; i++) {
            const p = {
              id: 'c1-p' + i,
              novelId: 'book',
              chapterId: 'c1',
              index: i,
              text: '바람이 불고 길이 이어졌다.',
            };
            await pool.query('insert into paragraph_search values($1,$2,$3,$4,$5,$6)', [
              'book',
              'c1',
              p.id,
              i,
              p,
              p.text,
            ]);
          }
          const job = await f.create();
          await f.until(async () => (await f.service.list('book'))[0].analyzedChapters === 1);
          const before = (await f.audio.get(job.id)).completed_items;
          blocked = true;
          // The next turn prepares a request, then the following turn dispatches it.
          // Release any short preparation turn's audio so the held model turn can begin.
          audioHeld.resolve();
          for (let n = 0; n < 5; n++) {
            pending = f.audio.tick();
            const state = await Promise.race([pending.then(() => 'turn'), entered.promise.then(() => 'model')]);
            if (state === 'model') break;
          }
          await Promise.race([
            entered.promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('model not entered')), 1500)),
          ]);
          if (ending === 'audio-limit') await audioEntered.promise;
          if (ending !== 'audio-limit') {
            await expect.poll(async () => (await f.audio.get(job.id)).completed_items).toBeGreaterThan(before);
            expect((await f.audio.get(job.id)).status).toBe('running');
          }
          expect(
            (await pool.query('select pg_try_advisory_xact_lock(61879419263191::bigint) locked')).rows[0].locked,
          ).toBe(false);
          if (ending === 'pause') await f.audio.control(job.id, 'pause');
          held.resolve();
          await pending;
          expect(peakAudio).toBeLessThanOrEqual(2);
          expect(activeAudio).toBe(0);
          const final = await f.audio.get(job.id);
          if (ending === 'pause') expect(final.status).toBe('paused');
          else if (ending === 'audio-limit') {
            expect(final.status).toBe('queued');
            expect(final.error_message).toContain('요청 제한');
            const count = f.synthesize.mock.calls.length;
            await f.audio.tick();
            expect(f.synthesize).toHaveBeenCalledTimes(count);
          } else {
            blocked = false;
            await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
            expect(new Set(f.synthesize.mock.calls.map((args) => args[3])).size).toBe(f.synthesize.mock.calls.length);
          }
        } finally {
          held.resolve();
          audioHeld.resolve();
          await pending;
          generate.mockRestore();
          await f.cleanup();
        }
      });
    },
  );
  it('selectively clears book audio/settings, keeps analysis and creates fresh audio without another analysis call', async () => {
    await withPostgresSchema(harness!, 'speaker_cleanup_reuse', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      try {
        const first = await f.create();
        await f.until(async () => (await f.audio.get(first.id)).status === 'completed');
        const calls = f.modelCalls.length;
        const analysis = (await pool.query('select result from speaker_analysis order by analysis_key')).rows;
        await pool.query("insert into speaker_generation_preferences values('book','owner',$1,now())", [
          { engineId: f.engine.id, narratorVoiceId: 'n', characterVoiceIds: ['a'], batchAudio: true },
        ]);
        await pool.query(
          "insert into speaker_voice_bindings(user_id,book_id,analysis_key,speaker_id,name,voice_id,model,metadata,pinned) values('owner','book','key','s1','민아','a','{}','{}',true)",
        );
        await pool.query("insert into library_books values('other-book','other','Other','txt','ko','rev',null)");
        await pool.query("insert into speaker_generation_preferences values('other-book','other','{}',now())");
        const options = { audio: true, settings: true, analysis: false };
        const preview = await f.service.previewCleanup('book', options);
        expect(preview).toMatchObject({ jobCount: 1, assignmentCount: 1, analysisCount: analysis.length });
        await expect(f.service.cleanup('book', options, preview.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        const result = await f.service.cleanup('book', options, preview.fingerprint, true);
        expect(result).toMatchObject({
          removedJobs: 1,
          removedAssignments: 1,
          removedAnalyses: 0,
          preferences: { engineId: f.engine.id, narratorVoiceId: '', characterVoiceIds: [] },
        });
        expect((await pool.query('select result from speaker_analysis order by analysis_key')).rows).toEqual(analysis);
        expect((await f.engines.list()).length).toBe(1);
        expect(
          (await pool.query("select value from speaker_generation_preferences where book_id='other-book'")).rows,
        ).toHaveLength(1);
        expect(await f.audio.audioStore.get(first.id, 0)).toBeUndefined();
        const second = await f.create();
        expect(second.id).not.toBe(first.id);
        await f.until(async () => (await f.audio.get(second.id)).status === 'completed');
        expect(f.modelCalls).toHaveLength(calls);
        expect((await f.service.reader(second.id, 'c1')).items[0].playable.preparedAudio?.ready).toBe(true);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('resets settings without deleting recordings and fences stale generation plans and stale cleanup previews', async () => {
    await withPostgresSchema(harness!, 'speaker_cleanup_epoch', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      try {
        const first = await f.create();
        await f.until(async () => (await f.audio.get(first.id)).status === 'completed');
        const saved = await f.audio.audio(first.id, 0);
        const old = await speakerPlan(pool, 'owner', 'book', f.input, await f.catalog(), f.engines);
        const options = { audio: false, settings: true, analysis: false };
        const preview = await f.service.previewCleanup('book', options);
        await f.service.cleanup('book', options, preview.fingerprint, true);
        await expect(f.audio.create(old.plan, old.estimate.fingerprint, true)).rejects.toMatchObject({
          statusCode: 409,
        });
        await expect(f.service.cleanup('book', options, preview.fingerprint, true)).rejects.toMatchObject({
          statusCode: 409,
        });
        expect(await f.audio.audio(first.id, 0)).toEqual(saved);
        const next = await f.create();
        expect(next.id).not.toBe(first.id);
        // Active work blocks all cleanup before any mutation.
        const blocked = await f.service.previewCleanup('book', options);
        expect(blocked.blockedReason).toContain('멈춘 뒤');
        await expect(f.service.cleanup('book', options, blocked.fingerprint, true)).rejects.toMatchObject({
          statusCode: 409,
        });
        await f.audio.control(next.id, 'pause');
        const analysisOnly = { audio: false, settings: false, analysis: true };
        expect((await f.service.previewCleanup('book', analysisOnly)).blockedReason).toContain('함께 삭제');
        const all = { audio: true, settings: false, analysis: true };
        const before = await f.service.previewCleanup('book', all);
        await f.service.cleanup('book', all, before.fingerprint, true);
        expect((await pool.query('select * from speaker_analysis')).rows).toHaveLength(0);
        await expect(f.service.previewCleanup('other-book', all)).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await f.cleanup();
      }
    });
  });
  it('clears analysis independently through the HTTP contract while preserving playable audio and the reset epoch on preference saves', async () => {
    await withPostgresSchema(harness!, 'speaker_cleanup_routes', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      const app = Fastify();
      app.addHook('onRequest', async (req) => {
        req.principal = { userId: 'owner', role: 'admin', authMethod: 'legacy-token' };
      });
      try {
        const job = await f.create();
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        await registerSpeakerGenerationRoutes(app, pool, f.config, f.service, f.audio, parsePlainTTSRules);
        const options = { audio: false, settings: false, analysis: true };
        const url = '/api/books/book/speaker-generation/cleanup';
        const preview = await app.inject({ method: 'POST', url: url + '/preview', payload: options });
        expect(preview.statusCode).toBe(200);
        const response = await app.inject({
          method: 'POST',
          url,
          payload: { ...options, fingerprint: preview.json().fingerprint, confirm: true },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ removedJobs: 0, removedAssignments: 0, removedAnalyses: 1 });
        expect((await f.service.reader(job.id, 'c1')).items[0].playable.preparedAudio?.ready).toBe(true);
        const epoch = (await pool.query("select value->>'generationEpoch' epoch from speaker_generation_preferences"))
          .rows[0].epoch;
        const saved = await app.inject({
          method: 'PUT',
          url: '/api/books/book/speaker-generation/preferences',
          payload: {
            engineId: f.engine.id,
            narratorVoiceId: 'n',
            characterVoiceIds: ['a'],
            generationEpoch: 'untrusted',
          },
        });
        expect(saved.statusCode).toBe(200);
        expect(
          (await pool.query("select value->>'generationEpoch' epoch from speaker_generation_preferences")).rows[0]
            .epoch,
        ).toBe(epoch);
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
  it('batches Gemini narration through generation, playback and revoice without replacing original audio', async () => {
    await withPostgresSchema(harness!, 'speaker_batch_roundtrip', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      try {
        const catalog = await f.catalog();
        f.catalog.mockResolvedValue({
          ...catalog,
          voices: catalog.voices.map((v) => ({
            ...v,
            model: { ...v.model!, modelId: 'gemini-3.8-flash-tts' },
            autoActingSupported: true,
          })),
        });
        await pool.query('delete from paragraph_search');
        const texts = ['아침이 밝았다.', '문이 열렸다.', '바람이 불었다.'];
        for (const [i, text] of texts.entries()) {
          const paragraph = { id: `c1-${i}`, novelId: 'book', chapterId: 'c1', index: i + 1, text };
          await pool.query('insert into paragraph_search values($1,$2,$3,$4,$5,$6)', [
            'book',
            'c1',
            paragraph.id,
            i + 1,
            paragraph,
            text,
          ]);
        }
        const defaultPlan = await f.service.estimate('book', f.input);
        const enabledPlan = await f.service.estimate('book', { ...f.input, batchAudio: true });
        expect(defaultPlan.fingerprint).not.toBe(enabledPlan.fingerprint);
        const original = await f.create({ ...f.input, batchAudio: true });
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        expect(f.synthesize).toHaveBeenCalledTimes(1);
        expect(f.synthesize.mock.calls[0][0]).toBe(texts.join('\n\n'));
        const recorded = await f.audio.resolve(original.id, 0);
        const reader = await f.service.reader(original.id, 'c1');
        expect(reader.items).toHaveLength(1);
        expect(reader.items[0]).toMatchObject({ paragraphIndex: 0, nextParagraphIndex: 3 });
        expect(reader.items[0].playable.plainBatchPositions).toHaveLength(3);
        const source = await f.service.revoiceSource('book', original.id);
        const input: SpeakerRevoiceInput = {
          batchAudio: true,
          voices: source.voices.map((v) => ({ speakerId: v.speakerId, voiceId: 'b' })),
        };
        expect(source.batched).toBe(true);
        const ungroupedInput: SpeakerRevoiceInput = {
          voices: source.voices.map((v) => ({ speakerId: v.speakerId, voiceId: v.voiceId })),
        };
        const ungrouped = await f.service.estimateRevoice('book', original.id, ungroupedInput);
        expect(ungrouped.itemCount).toBe(3);
        const beforeCalls = f.modelCalls.length;
        const estimate = await f.service.estimateRevoice('book', original.id, input);
        expect(estimate.itemCount).toBe(1);
        const next = await f.service.revoice('book', original.id, input, estimate.fingerprint, true);
        await f.until(async () => (await f.audio.get(next.id)).status === 'completed');
        expect(f.modelCalls).toHaveLength(beforeCalls);
        expect(f.synthesize).toHaveBeenCalledTimes(2);
        expect(f.synthesize.mock.calls[1][0]).toBe(texts.join('\n\n'));
        expect(await f.audio.resolve(original.id, 0)).toEqual(recorded);
        await pool.query(
          "update paragraph_search set text='변경됨',paragraph=jsonb_set(paragraph,'{text}','\"변경됨\"') where paragraph_id='c1-2'",
        );
        await expect(f.service.render(next.id, 0, true)).rejects.toMatchObject({ statusCode: 409 });
        expect(f.synthesize).toHaveBeenCalledTimes(2);
      } finally {
        await f.cleanup();
      }
    });
  });

  it('revoices captured audio with no analysis calls, independent cache identities and an immutable original', async () => {
    await withPostgresSchema(harness!, 'speaker_revoice', async (pool) => {
      const f = await setup(pool);
      try {
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const before = (
          await pool.query(
            'select ordinal,request,cache_key from saved_audiobook_items where audiobook_id=$1 order by ordinal',
            [original.id],
          )
        ).rows;
        const source = await f.service.revoiceSource('book', original.id);
        const input = {
          voices: source.voices.map((v) => ({
            speakerId: v.speakerId,
            voiceId: v.speakerId === 'narrator' ? v.voiceId : 'b',
            ...(v.speakerId === 'narrator' ? {} : { instructions: '낮고 차분한 목소리로.' }),
          })),
        };
        await f.engines.remove(f.engine.id);
        f.fetchImpl.mockClear();
        f.synthesize.mockClear();
        const estimate = await f.service.estimateRevoice('book', original.id, input);
        expect(estimate).toMatchObject({ paid: true, chapterCount: 2, itemCount: before.length });
        await expect(f.service.revoice('book', original.id, input, estimate.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        const next = await f.service.revoice('book', original.id, input, estimate.fingerprint, true);
        expect(next.id).not.toBe(original.id);
        expect(next.revoiceFrom).toBe(original.id);
        expect(next.planningComplete).toBe(true);
        expect((await f.service.revoice('book', original.id, input, estimate.fingerprint, true)).id).toBe(next.id);
        await f.until(async () => (await f.audio.get(next.id)).status === 'completed');
        expect(f.fetchImpl).not.toHaveBeenCalled();
        const after = (
          await pool.query(
            'select ordinal,request,cache_key from saved_audiobook_items where audiobook_id=$1 order by ordinal',
            [next.id],
          )
        ).rows;
        for (const [i, item] of after.entries()) {
          expect(item.request.paragraphHash).toBe(before[i].request.paragraphHash);
          expect(item.request.chunkHash).toBe(before[i].request.chunkHash);
          expect(item.request.cast).toMatchObject({
            start: before[i].request.cast.start,
            end: before[i].request.cast.end,
            part: before[i].request.cast.part,
            speakerId: before[i].request.cast.speakerId,
          });
          if (item.request.cast.speakerId === 'narrator') expect(item.cache_key).toBe(before[i].cache_key);
          else {
            expect(item.cache_key).not.toBe(before[i].cache_key);
            expect(item.request.cast.instructions).toBe('낮고 차분한 목소리로.');
          }
        }
        expect(
          (
            await pool.query(
              'select ordinal,request,cache_key from saved_audiobook_items where audiobook_id=$1 order by ordinal',
              [original.id],
            )
          ).rows,
        ).toEqual(before);
        expect(f.synthesize.mock.calls.some((call) => (call as unknown[])[5] === '낮고 차분한 목소리로.')).toBe(true);
        await f.service.remove(original.id);
        expect((await f.service.list('book')).some((job) => job.id === next.id)).toBe(true);
        expect((await pool.query('select count(*)::int n from speaker_analysis')).rows[0].n).toBeGreaterThan(0);
        expect((await f.service.reader(next.id, 'c1')).items[0].playable.preparedAudio?.id).toBe(next.id);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('validates full revoice choices, capabilities, source identity and transactional source/owner fences', async () => {
    await withPostgresSchema(harness!, 'revoice_fences', async (pool) => {
      const f = await setup(pool);
      try {
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const source = await f.service.revoiceSource('book', original.id);
        const input = {
          voices: source.voices.map((v) => ({ speakerId: v.speakerId, voiceId: 'b', instructions: '또렷하게.' })),
        };
        for (const bad of [
          { voices: [] },
          { voices: [input.voices[0], input.voices[0]] },
          { voices: input.voices.map((v) => ({ ...v, voiceId: 'missing' })) },
          { voices: input.voices.map((v) => ({ ...v, voiceId: 'a' })) },
          { voices: input.voices.map((v) => ({ ...v, instructions: 'x'.repeat(2001) })) },
        ])
          await expect(f.service.estimateRevoice('book', original.id, bad)).rejects.toHaveProperty('statusCode');
        await expect(f.service.revoiceSource('other-book', original.id)).rejects.toMatchObject({ statusCode: 409 });
        const plan = await planSpeakerRevoice(pool, 'owner', 'book', original.id, input, await f.catalog());
        await pool.query("update saved_audiobooks set status='running' where id=$1", [original.id]);
        await expect(f.audio.create(plan, plan.estimate.fingerprint, true)).rejects.toMatchObject({ statusCode: 409 });
        await pool.query("update saved_audiobooks set status='completed' where id=$1", [original.id]);
        await pool.query("update self_host_accounts set role='member' where user_id='owner'");
        await expect(f.audio.create(plan, plan.estimate.fingerprint, true)).rejects.toMatchObject({ statusCode: 409 });
        await pool.query("update self_host_accounts set role='admin' where user_id='owner'");
        await pool.query("update library_books set active_content_revision_id='new' where id='book'");
        await expect(f.audio.create(plan, plan.estimate.fingerprint, true)).rejects.toMatchObject({ statusCode: 409 });
        expect((await pool.query('select count(*)::int n from saved_audiobooks')).rows[0].n).toBe(1);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('copies only fully planned chapters from a paused partial job and never restarts analysis on resume', async () => {
    await withPostgresSchema(harness!, 'revoice_partial', async (pool) => {
      const f = await setup(pool);
      try {
        const original = await f.create();
        await f.until(async () => (await f.service.list('book')).find((job) => job.id === original.id)!.itemCount > 0);
        await f.audio.control(original.id, 'pause');
        const source = await f.service.revoiceSource('book', original.id);
        expect(source.chapterCount).toBe(1);
        const input = { voices: source.voices.map((v) => ({ speakerId: v.speakerId, voiceId: 'b' })) };
        const estimate = await f.service.estimateRevoice('book', original.id, input);
        const next = await f.service.revoice('book', original.id, input, estimate.fingerprint, true);
        expect(next.chapterIds).toEqual(['c1']);
        expect(next.itemCount).toBe(source.itemCount);
        await f.audio.control(next.id, 'pause');
        await f.engines.remove(f.engine.id);
        f.fetchImpl.mockClear();
        await f.audio.control(next.id, 'resume', true);
        await f.until(async () => (await f.audio.get(next.id)).status === 'completed');
        expect(f.fetchImpl).not.toHaveBeenCalled();
        expect((await f.audio.get(original.id)).status).toBe('paused');
      } finally {
        await f.cleanup();
      }
    });
  });
  it('reports context analysis position and durable retry time before an audio plan exists', async () => {
    await withPostgresSchema(harness!, 'speaker_progress', async (pool) => {
      const f = await setup(pool);
      try {
        const job = await f.create({ ...f.input, chapterIds: ['c2'] });
        await pool.query("update speaker_generation_runs set stage='identity' where audiobook_id=$1", [job.id]);
        await pool.query(
          "update saved_audiobooks set retry_at=now()+interval '5 minutes',rate_limit_attempts=6 where id=$1",
          [job.id],
        );
        const first = (await f.service.list('book'))[0];
        expect(first).toMatchObject({
          chapterCount: 1,
          itemCount: 0,
          completedItems: 0,
          analyzedChapters: 0,
          planningComplete: false,
          analysisProgress: { chapterCount: 2, currentChapter: { number: 1, title: 'First', contextOnly: true } },
        });
        expect(Date.parse(first.retryAt!)).toBeGreaterThan(Date.now());
        await pool.query('update speaker_generation_runs set next_chapter=1 where audiobook_id=$1', [job.id]);
        await pool.query("update saved_audiobooks set status='running' where id=$1", [job.id]);
        const next = (await f.service.list('book'))[0];
        expect(next.analysisProgress?.currentChapter).toEqual({ number: 2, title: 'Second', contextOnly: false });
        expect(next.retryAt).toBeUndefined();
        expect(next.analyzedChapters).toBe(1);
        expect(f.synthesize).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    });
  });
  it('plays prepared source spans during generation, keeps stable voices, and reuses analysis for another voice pool', async () => {
    await withPostgresSchema(harness!, 'speaker_full', async (pool) => {
      const f = await setup(pool, 2);
      try {
        const estimate = await f.service.estimate('book', f.input);
        await expect(f.service.create('book', f.input, estimate.fingerprint, false)).rejects.toThrow('API');
        const job = await f.create();
        await f.until(async () => (await f.service.list('book'))[0].readyChapterIds.includes('c1'));
        expect((await f.service.list('book'))[0].status).not.toBe('completed');
        const plan = await f.audio.reader('book', 'c1', { id: job.id });
        expect(plan?.items.length).toBe(3);
        expect(plan?.items.map((i) => i.playable.text).join('')).toContain('민아가 말했다.');
        expect(plan?.items[1].playable.speakerLabel).toBe('민아');
        if (!plan) throw new Error('missing prepared plan');
        const chapter = await loadSpeakerChapter(pool, 'owner', 'book', 'c1', 1);
        const heard: string[] = [];
        const highlighted: { paragraphId: string; ranges: { start: number; end: number }[] }[] = [];
        const fallback = vi.fn();
        const played = await runTTSPlaybackSession({
          ...preparedNarrationSession(plan, 0, async (i) => chapter.paragraphs[i]),
          shouldContinue: () => true,
          waitForResume: async () => true,
          buildPlayableSegments: () => [],
          allowSystemFallback: false,
          speakSystem: fallback,
          buildSystemFallbackInput: () => ({ text: 'forbidden', rate: 1 }),
          playHostedSegment: async (item) => {
            heard.push(item.text);
            await f.audio.resolve(job.id, item.preparedAudio!.ordinal);
            return true;
          },
          onActivePlayback: (p) => {
            if (p) highlighted.push({ paragraphId: p.paragraphId, ranges: p.ranges });
          },
        });
        expect(played.completed).toBe(true);
        expect(heard).toEqual(plan.items.map((i) => i.playable.text));
        expect(fallback).not.toHaveBeenCalled();
        expect(highlighted.length).toBe(3);
        expect(highlighted).toEqual(
          plan.items.map((i) => ({
            paragraphId: chapter.paragraphs[i.paragraphIndex].id,
            ranges: i.playable.sourceRanges.map((r) => ({ start: r.startOffset, end: r.endOffset })),
          })),
        );
        for (const [index, active] of highlighted.entries()) {
          const p = chapter.paragraphs.find((p) => p.id === active.paragraphId)!;
          expect(
            active.ranges
              .map((r) => p.text.slice(r.start, r.end))
              .join('')
              .trim(),
          ).toBe(heard[index]);
        }

        expect(plan?.items[1].playable.sourceRanges[0].startOffset).toBeGreaterThan(0);
        const saved = await f.audio.audio(job.id, 0);
        const count = f.synthesize.mock.calls.length;
        expect((await f.audio.resolve(job.id, 0)).data).toEqual(saved.data);
        expect(f.synthesize.mock.calls.length).toBe(count);
        await f.until(async () => (await f.service.list('book'))[0].status === 'completed');
        expect(f.synthesize.mock.calls).toHaveLength(6);
        expect(
          (
            await pool.query(
              "select request->>'voiceId' voice from saved_audiobook_items where audiobook_id=$1 order by ordinal",
              [job.id],
            )
          ).rows.map((r) => r.voice),
        ).toEqual(['n', 'a', 'n', 'n', 'a', 'n']);
        const modelCalls = () => f.requests.filter((r) => r.url.endsWith('/chat/completions')).length;
        expect(modelCalls()).toBe(4);
        const second = await f.create({ ...f.input, characterVoiceIds: ['b'] });
        await f.until(
          async () => (await f.service.list('book')).find((j) => j.id === second.id)?.status === 'completed',
        );
        expect(modelCalls()).toBe(4);
        expect(f.synthesize.mock.calls.slice(6)).toHaveLength(6);
        expect(
          (
            await pool.query(
              "select request->>'voiceId' voice from saved_audiobook_items where audiobook_id=$1 order by ordinal",
              [second.id],
            )
          ).rows.map((r) => r.voice),
        ).toEqual(['n', 'b', 'n', 'n', 'b', 'n']);
        for (const r of f.requests.filter((r) => r.url.startsWith('http://engine.test')))
          expect(r.headers.get('authorization')).toBe('Bearer fixture-engine-token-12345678');
        expect(
          JSON.stringify(f.requests.filter((r) => r.url.startsWith('http://engine.test')).map((r) => r.body)),
        ).not.toContain('fixture-model-secret');
        expect(await f.audio.list('book')).toEqual([]);
        await f.engines.remove(f.engine.id);
        expect((await f.audio.reader('book', 'c2', { id: job.id }))?.items[0].playable.preparedAudio?.ready).toBe(true);
        await f.service.remove(second.id);
        expect(Number((await pool.query('select count(*) n from speaker_analysis')).rows[0].n)).toBe(2);
        await f.service.remove(job.id);
        expect(Number((await pool.query('select count(*) n from speaker_analysis')).rows[0].n)).toBe(2);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('counts only unselected context chapters and selected narration characters while analyzing from chapter one', async () => {
    await withPostgresSchema(harness!, 'speaker_estimate', async (pool) => {
      const f = await setup(pool);
      try {
        await pool.query("update library_books set language='en-US' where id='book'");
        const length = Number(
          (await pool.query("select sum(length(text)) n from paragraph_search where chapter_id='c2'")).rows[0].n,
        );
        expect(await f.service.estimate('book', f.input)).toMatchObject({
          chapterCount: 2,
          contextChapterCount: 0,
          characters: 2 * length,
        });
        const input = { ...f.input, chapterIds: ['c2'] };
        expect(await f.service.estimate('book', input)).toMatchObject({
          chapterCount: 1,
          contextChapterCount: 1,
          characters: length,
        });
        const job = await f.create(input);
        expect((await f.audio.get(job.id)).settings.cast?.language).toBe('en-US');
        expect(job.contextChapterCount).toBe(1);
        await f.until(async () => (await f.service.list('book'))[0].status === 'completed');
        expect((await f.service.list('book'))[0]).toMatchObject({
          chapterIds: ['c2'],
          contextChapterCount: 1,
          analyzedChapters: 2,
          readyChapterIds: ['c2'],
        });
        expect(f.synthesize.mock.calls.map((c) => c[1])).toEqual(['n', 'a', 'n']);
        expect(f.requests.filter((r) => r.url.endsWith('/chat/completions'))).toHaveLength(4);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('saves an in-flight paid response on user pause and resumes without another model request', async () => {
    await withPostgresSchema(harness!, 'speaker_pause', async (pool) => {
      const f = await setup(pool);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const original = f.engines.transport.generate.bind(f.engines.transport);
      let signal: AbortSignal | undefined;
      const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementationOnce(async (...args) => {
        signal = args[2];
        started();
        await gate;
        return original(...args);
      });
      let pending: Promise<boolean> | undefined;
      try {
        const job = await f.create();
        await f.audio.tick();
        pending = f.audio.tick();
        await entered;
        await f.audio.control(job.id, 'pause');
        expect(signal?.aborted).toBe(false);
        release();
        await pending;
        expect((await f.audio.get(job.id)).status).toBe('paused');
        const state = (
          await pool.query(
            'select model_response,dispatching,bytes,octet_length(checkpoint::text)+octet_length(model_response) expected from speaker_analysis',
          )
        ).rows[0];
        expect(state.model_response).toContain('NEW_1');
        expect(state.dispatching).toBe(false);
        expect(Number(state.bytes)).toBe(Number(state.expected));
        await f.audio.tick();
        expect(generate).toHaveBeenCalledTimes(1);
        await f.audio.control(job.id, 'resume', true);
        await f.audio.tick();
        expect(generate).toHaveBeenCalledTimes(1);
        await f.until(async () => (await f.service.list('book'))[0].status === 'completed');
        expect(generate).toHaveBeenCalledTimes(4);
      } finally {
        release();
        await pending;
        generate.mockRestore();
        await f.cleanup();
      }
    });
  });
  it('blocks dispatch without response headroom and rolls back a response that exceeds the owner quota', async () => {
    await withPostgresSchema(harness!, 'speaker_quota', async (pool) => {
      const f = await setup(pool);
      try {
        const job = await f.create();
        await f.audio.tick();
        // Synthetic accounting rows reach quota without allocating hundreds of MiB in the test.
        await pool.query(`insert into speaker_analysis(user_id,book_id,analysis_key,chapter_id,input_hash,bytes)
          select 'owner','book','quota',i::text,'fixture',16777216 from generate_series(1,32) i`);
        const before = f.requests.length;
        await f.audio.tick();
        expect(f.requests.length).toBe(before + 1); // Engine capabilities, never the paid model.
        expect(f.requests.filter((r) => r.url.endsWith('/chat/completions'))).toHaveLength(0);
        expect((await f.audio.get(job.id)).status).toBe('failed');
        expect(
          (await pool.query("select dispatching from speaker_analysis where analysis_key<>'quota'")).rows[0]
            .dispatching,
        ).toBe(false);
        await pool.query("delete from speaker_analysis where analysis_key='quota'");
        await f.audio.control(job.id, 'resume', true);
        const original = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementationOnce(async (...args) => {
          const response = await original(...args);
          await pool.query(`insert into speaker_analysis(user_id,book_id,analysis_key,chapter_id,input_hash,bytes)
            select 'owner','book','quota',i::text,'fixture',16777216 from generate_series(1,32) i`);
          return response;
        });
        try {
          await f.audio.tick();
        } finally {
          generate.mockRestore();
        }
        expect((await f.audio.get(job.id)).status).toBe('failed');
        const state = (
          await pool.query(
            "select model_response,bytes,octet_length(checkpoint::text) expected from speaker_analysis where analysis_key<>'quota'",
          )
        ).rows[0];
        expect(state.model_response).toBeNull();
        expect(Number(state.bytes)).toBe(Number(state.expected));
      } finally {
        await f.cleanup();
      }
    });
  });
  it('recounts UTF-8 bytes when explicit resume discards a rejected model response', async () => {
    await withPostgresSchema(harness!, 'speaker_resume_bytes', async (pool) => {
      const f = await setup(pool);
      try {
        const job = await f.create();
        await f.audio.tick();
        await f.audio.tick();
        const original = f.fetchImpl.getMockImplementation()!;
        f.fetchImpl.mockImplementation(async (...args) =>
          String(args[0]).endsWith('/v1/step') ? new Response('', { status: 422 }) : original(...args),
        );
        await f.audio.tick();
        const old = (await pool.query('select response_rejected,model_response,bytes from speaker_analysis')).rows[0];
        expect(old.response_rejected).toBe(true);
        expect(old.model_response).not.toBeNull();
        await f.audio.control(job.id, 'resume', true);
        const state = (
          await pool.query(
            "select response_rejected,model_response,dispatching,bytes,octet_length(coalesce(checkpoint::text,''))+octet_length(coalesce(result::text,'')) expected from speaker_analysis",
          )
        ).rows[0];
        expect(state).toMatchObject({ response_rejected: false, model_response: null, dispatching: false });
        expect(Number(state.bytes)).toBe(Number(state.expected));
        expect(Number(state.bytes)).toBeLessThan(Number(old.bytes));
      } finally {
        await f.cleanup();
      }
    });
  });
  it('still aborts an in-flight model request on server shutdown without automatic replay', async () => {
    await withPostgresSchema(harness!, 'speaker_shutdown', async (pool) => {
      const f = await setup(pool);
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let signal: AbortSignal | undefined;
      const generate = vi
        .spyOn(f.engines.transport, 'generate')
        .mockImplementationOnce(async (_config, _request, current) => {
          signal = current;
          started();
          return new Promise<string>((_resolve, reject) =>
            current.addEventListener('abort', () => reject(current.reason), { once: true }),
          );
        });
      let pending: Promise<boolean> | undefined;
      try {
        await f.create();
        await f.audio.tick();
        pending = f.audio.tick();
        await entered;
        await f.audio.stop();
        await pending;
        expect(signal?.aborted).toBe(true);
        await f.audio.tick();
        expect(generate).toHaveBeenCalledTimes(1);
        expect((await pool.query('select model_response from speaker_analysis')).rows[0].model_response).toBeNull();
      } finally {
        await pending;
        generate.mockRestore();
        await f.cleanup();
      }
    });
  });
  it.each(['owner', 'admin'] as const)(
    'rejects %s revocation committed while chapter acceptance waits on its row lock',
    async (kind) => {
      await withPostgresSchema(harness!, 'speaker_accept_race', async (pool) => {
        const f = await setup(pool);
        const revoker = await pool.connect();
        let pending: Promise<boolean> | undefined;
        let committed = false;
        try {
          const job = await f.create();
          await f.until(
            async () => (await pool.query('select 1 from speaker_analysis where result is not null')).rowCount === 1,
          );
          await revoker.query('begin');
          await revoker.query(
            kind === 'owner'
              ? "update library_books set user_id='other' where id='book'"
              : "update self_host_accounts set role='member' where user_id='owner'",
          );
          pending = f.audio.tick();
          let waiting = false;
          for (let n = 0; n < 100; n++) {
            await revoker.query('select pg_stat_clear_snapshot()');
            waiting =
              Number(
                (
                  await revoker.query(
                    "select count(*) n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'",
                  )
                ).rows[0].n,
              ) > 0;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          await revoker.query('commit');
          committed = true;
          await pending;
          const row = (await pool.query('select status from saved_audiobooks where id=$1', [job.id])).rows[0];
          expect(row.status).toBe('failed');
          expect((await pool.query('select count(*)::int n from saved_audiobook_items')).rows[0].n).toBe(0);
          expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(0);
          expect(f.synthesize).not.toHaveBeenCalled();
        } finally {
          if (!committed) await revoker.query('rollback');
          revoker.release();
          await pending;
          await f.cleanup();
        }
      });
    },
  );
  it('keeps completed model replies after engine outages and persists 429 backoff without ambiguous replay', async () => {
    await withPostgresSchema(harness!, 'speaker_retry', async (pool) => {
      const f = await setup(pool);
      try {
        const job = await f.create();
        await f.audio.tick();
        f.setLimit();
        await f.audio.tick();
        const row = await f.audio.get(job.id);
        expect(row.status).toBe('queued');
        const before = f.requests.length;
        await f.audio.tick();
        expect(f.requests.length).toBe(before);
        await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second'");
        await f.audio.tick();
        f.setFail();
        await f.audio.tick();
        expect((await f.audio.get(job.id)).status).toBe('failed');
        expect((await pool.query('select model_response from speaker_analysis')).rows[0].model_response).toContain(
          'NEW_1',
        );
        const calls = f.requests.filter((r) => r.url.endsWith('/chat/completions')).length;
        await f.audio.control(job.id, 'resume', true);
        await f.audio.tick();
        expect(f.requests.filter((r) => r.url.endsWith('/chat/completions')).length).toBe(calls);
        await f.until(async () => (await f.service.list('book'))[0].status === 'completed');
      } finally {
        await f.cleanup();
      }
    });
  });
  it('persists only safe settings, enforces ownership and fences source changes after awaited analysis', async () => {
    await withPostgresSchema(harness!, 'speaker_security', async (pool) => {
      const f = await setup(pool);
      const app = Fastify();
      let owner = 'owner';
      try {
        app.addHook('onRequest', async (req) => {
          req.principal = { userId: owner, role: 'admin', authMethod: 'legacy-token' };
        });
        await registerSpeakerGenerationRoutes(app, pool, f.config, f.service, f.audio, parsePlainTTSRules);
        const url = '/api/books/book/speaker-generation/preferences';
        const value = { engineId: 'missing', narratorVoiceId: 'n', characterVoiceIds: ['a'] };
        expect((await app.inject({ method: 'PUT', url, payload: value })).statusCode).toBe(200);
        expect((await app.inject(url)).json().preferences).toEqual(value);
        owner = 'other';
        expect((await app.inject(url)).statusCode).toBe(403);
        owner = 'owner';
        const models = (await app.inject('/api/tts/speaker-engines')).json();
        expect(JSON.stringify(models)).not.toContain('fixture-model-secret');
        await expect(f.engines.save({ ...f.engine, url: 'http://different.test/v1' }, f.engine.id)).rejects.toThrow(
          '키',
        );
        const job = await f.create();
        await f.audio.tick();
        const original = f.fetchImpl.getMockImplementation()!;
        f.fetchImpl.mockImplementationOnce(async (...args) => original(...args));
        const generate = vi.spyOn(f.engines.transport, 'generate');
        const old = f.engines.transport.generate.bind(f.engines.transport);
        generate.mockImplementation(async () => {
          await pool.query("update library_books set active_content_revision_id='changed'");
          return '{}';
        });
        await f.audio.tick();
        expect((await f.audio.get(job.id)).status).toBe('failed');
        expect((await pool.query('select model_response from speaker_analysis')).rows[0].model_response).toBeNull();
        expect(f.synthesize).not.toHaveBeenCalled();
        generate.mockRestore();
        void old;
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

(harness ? describe : describe.skip)('parallel A preparation and sequential identity persistence', () => {
  it('dispatches B1 while A2 is held within total concurrency 2, shares cache and preserves it after the final voice variant is removed', async () => {
    await withPostgresSchema(harness!, 'speaker_parallel_order', async (pool) => {
      const f = await setup(pool);
      const gates = { c1: gate(), c2: gate() };
      const entered: string[] = [];
      let active = 0;
      let peak = 0;
      const original = f.engines.transport.generate.bind(f.engines.transport);
      const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
        const { input, request } = f.context(args[1]);
        active++;
        peak = Math.max(peak, active);
        try {
          if (request.stage === 'attribution') {
            entered.push(input.source.chapter.id);
            await gates[input.source.chapter.id as keyof typeof gates].promise;
          }
          return await original(...args);
        } finally {
          active--;
        }
      });
      let pending: Promise<boolean> | undefined;
      try {
        const configured = await f.engines.save({ ...f.engine, analysisConcurrency: 2 }, f.engine.id);
        const job = await f.create();
        await f.audio.tick();
        expect(f.modelCalls).toHaveLength(0);
        let settled = false;
        pending = f.audio.tick().finally(() => {
          settled = true;
        });
        await vi.waitFor(() => expect(entered).toHaveLength(2));
        expect(new Set(entered)).toEqual(new Set(['c1', 'c2']));
        expect(peak).toBe(2);
        gates.c1.resolve();
        await vi.waitFor(async () =>
          expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(1),
        );
        // This records the actual model HTTP request, not merely a prepared B prompt.
        expect(
          f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
        ).toEqual(['c1']);
        expect(active).toBe(1);
        expect(settled).toBe(false);
        const analysisKey = (await pool.query('select analysis_key from speaker_generation_runs')).rows[0].analysis_key;
        const lock = `speaker:owner:book:${analysisKey}`;
        expect(
          (await pool.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', [lock])).rows[0].locked,
        ).toBe(false);
        expect(f.synthesize).not.toHaveBeenCalled();
        gates.c2.resolve();
        await pending;
        expect(
          (await pool.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', [lock])).rows[0].locked,
        ).toBe(true);
        expect(peak).toBe(2);
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        expect(
          f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
        ).toEqual(['c1', 'c2']);
        const prior = f.modelCalls.find((c) => c.request.stage === 'identity' && c.input.source.chapter.id === 'c2')!
          .input.ledger as { entries: unknown[] };
        expect(prior.entries).toHaveLength(1);
        const calls = generate.mock.calls.length;
        const assignments = (
          await pool.query('select assignments from speaker_generation_runs where audiobook_id=$1', [job.id])
        ).rows[0].assignments;
        const changed = await f.engines.save(
          { ...configured, analysisConcurrency: 1, rateLimitRetries: 0 },
          f.engine.id,
        );
        expect(changed).toMatchObject({ revision: configured.revision, rateLimitRetries: 0, hasApiKey: true });
        expect((await f.engines.list())[0]).toMatchObject({ analysisConcurrency: 1, rateLimitRetries: 0 });
        const variant = await f.create({ ...f.input, characterVoiceIds: ['b'] });
        await f.until(async () => (await f.audio.get(variant.id)).status === 'completed');
        expect(generate).toHaveBeenCalledTimes(calls);
        expect(
          (await pool.query('select assignments from speaker_generation_runs where audiobook_id=$1', [job.id])).rows[0]
            .assignments,
        ).toEqual(assignments);
        expect((await pool.query('select count(*)::int n from speaker_analysis')).rows[0].n).toBe(4);
        await f.service.remove(job.id);
        expect((await pool.query('select count(*)::int n from speaker_analysis')).rows[0].n).toBe(4);
        await f.service.remove(variant.id);
        expect((await pool.query('select count(*)::int n from speaker_analysis')).rows[0].n).toBe(4);
      } finally {
        gates.c1.resolve();
        gates.c2.resolve();
        await pending;
        generate.mockRestore();
        await f.cleanup();
      }
    });
  });

  it('dispatches ordered B1 and B2 while A3 is held with a total cap of 3 and no replacement A4', async () => {
    await withPostgresSchema(harness!, 'speaker_priority_three', async (pool) => {
      const f = await setup(pool, 1, ['c1', 'c2', 'c3', 'c4']);
      const held = { c1: gate(), c2: gate(), c3: gate(), c4: gate() };
      const b1 = gate();
      const entered: string[] = [];
      const startedB: string[] = [];
      let active = 0;
      let peak = 0;
      let activeB = 0;
      let peakB = 0;
      let settled = false;
      const original = f.engines.transport.generate.bind(f.engines.transport);
      const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
        const { input, request } = f.context(args[1]);
        const id = input.source.chapter.id;
        active++;
        peak = Math.max(peak, active);
        if (request.stage === 'identity') {
          activeB++;
          peakB = Math.max(peakB, activeB);
          startedB.push(id);
        }
        try {
          if (request.stage === 'attribution') {
            entered.push(id);
            await held[id as keyof typeof held].promise;
          }
          const response = await original(...args);
          if (request.stage === 'identity' && id === 'c1') await b1.promise;
          return response;
        } finally {
          active--;
          if (request.stage === 'identity') activeB--;
        }
      });
      let pending: Promise<boolean> | undefined;
      try {
        await f.engines.save({ ...f.engine, analysisConcurrency: 3 }, f.engine.id);
        const job = await f.create();
        await f.audio.tick();
        expect(f.modelCalls).toHaveLength(0);
        pending = f.audio.tick().finally(() => {
          settled = true;
        });
        await vi.waitFor(() => expect(entered).toHaveLength(3));
        expect(new Set(entered)).toEqual(new Set(['c1', 'c2', 'c3']));
        held.c1.resolve();
        await vi.waitFor(() =>
          expect(
            f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
          ).toEqual(['c1']),
        );
        expect(active).toBe(3);
        held.c2.resolve();
        const key = attributionKey(
          (await pool.query('select analysis_key from speaker_generation_runs')).rows[0].analysis_key,
        );
        await vi.waitFor(async () =>
          expect(
            (await pool.query("select result from speaker_analysis where analysis_key=$1 and chapter_id='c2'", [key]))
              .rows[0].result,
          ).not.toBeNull(),
        );
        expect(startedB).toEqual(['c1']);
        b1.resolve();
        await vi.waitFor(async () =>
          expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(2),
        );
        expect(
          f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
        ).toEqual(['c1', 'c2']);
        expect(
          f.modelCalls.find((c) => c.request.stage === 'identity' && c.input.source.chapter.id === 'c2')!.input.ledger,
        ).toMatchObject({ throughChapterIndex: 1, entries: [expect.anything()] });
        expect(peak).toBe(3);
        expect(peakB).toBe(1);
        expect(active).toBe(1);
        expect(settled).toBe(false);
        expect(entered).not.toContain('c4');
        expect(f.synthesize).not.toHaveBeenCalled();
        expect(
          (
            await pool.query(
              "select count(*)::int n from saved_audiobook_items where audiobook_id=$1 and status<>'ready'",
              [job.id],
            )
          ).rows[0].n,
        ).toBe(6);
        held.c3.resolve();
        await pending;
        expect(startedB).toEqual(['c1', 'c2', 'c3']);
        expect(entered).not.toContain('c4');
        expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(3);
        held.c4.resolve();
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        expect(startedB).toEqual(['c1', 'c2', 'c3', 'c4']);
        expect(entered).toHaveLength(4);
        expect(peak).toBe(3);
        expect(peakB).toBe(1);
      } finally {
        Object.values(held).forEach((g) => g.resolve());
        b1.resolve();
        await pending;
        generate.mockRestore();
        await f.cleanup();
      }
    });
  });

  it.each(['pause', 'B429'] as const)(
    'stops new dispatch after %s while A2 is held, saves in-flight success and resumes without replay',
    async (stop) => {
      await withPostgresSchema(harness!, 'speaker_priority_stop', async (pool) => {
        const f = await setup(pool);
        const heldA2 = gate();
        const heldB1 = gate();
        const b1Limited = gate();
        const enteredA: string[] = [];
        const observedSignals: AbortSignal[] = [];
        let limited = false;
        let settled = false;
        const original = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
          const { input, request } = f.context(args[1]);
          const id = input.source.chapter.id;
          observedSignals.push(args[2]);
          if (request.stage === 'attribution') {
            enteredA.push(id);
            if (id === 'c2') await heldA2.promise;
          }
          if (stop === 'B429' && request.stage === 'identity' && id === 'c1' && !limited) {
            limited = true;
            f.setLimit();
            try {
              return await original(...args);
            } finally {
              b1Limited.resolve();
            }
          }
          const response = await original(...args);
          if (request.stage === 'identity' && id === 'c1') await heldB1.promise;
          return response;
        });
        let pending: Promise<boolean> | undefined;
        try {
          await f.engines.save({ ...f.engine, analysisConcurrency: 2, rateLimitRetries: 0 }, f.engine.id);
          const job = await f.create();
          await f.audio.tick();
          pending = f.audio.tick().finally(() => {
            settled = true;
          });
          await vi.waitFor(() =>
            expect(
              f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
            ).toEqual(['c1']),
          );
          if (stop === 'pause') {
            await f.audio.control(job.id, 'pause');
            expect(observedSignals.every((signal) => !signal.aborted)).toBe(true);
            heldB1.resolve();
            await vi.waitFor(async () =>
              expect(
                (
                  await pool.query(
                    "select model_response from speaker_analysis where chapter_id='c1' and analysis_key=(select analysis_key from speaker_generation_runs) ",
                  )
                ).rows[0].model_response,
              ).not.toBeNull(),
            );
          } else {
            await b1Limited.promise;
            heldB1.resolve();
            await vi.waitFor(async () =>
              expect(
                (
                  await pool.query(
                    "select dispatching from speaker_analysis where chapter_id='c1' and analysis_key=(select analysis_key from speaker_generation_runs) ",
                  )
                ).rows[0].dispatching,
              ).toBe(false),
            );
          }
          expect(enteredA).toHaveLength(2);
          expect(settled).toBe(false);
          expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(0);
          const calls = generate.mock.calls.length;
          expect(calls).toBe(3);
          const key = (await pool.query('select analysis_key from speaker_generation_runs')).rows[0].analysis_key;
          const lock = `speaker:owner:book:${key}`;
          expect(
            (await pool.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', [lock])).rows[0]
              .locked,
          ).toBe(false);
          heldA2.resolve();
          await pending;
          expect(generate).toHaveBeenCalledTimes(calls);
          expect((await f.audio.get(job.id)).status).toBe(stop === 'pause' ? 'paused' : 'failed');
          expect(
            (
              await pool.query(
                "select model_response,result,dispatching from speaker_analysis where chapter_id='c2' and analysis_key=$1",
                [attributionKey(key)],
              )
            ).rows[0],
          ).toMatchObject({ model_response: expect.stringContaining('NEW_1'), result: null, dispatching: false });
          expect(
            (await pool.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', [lock])).rows[0]
              .locked,
          ).toBe(true);
          await f.engines.save({ ...f.engine, analysisConcurrency: 1, rateLimitRetries: 0 }, f.engine.id);
          await f.audio.control(job.id, 'resume', true);
          await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
          expect(
            f.modelCalls
              .filter((c) => c.request.stage === 'attribution')
              .map((c) => c.input.source.chapter.id)
              .sort(),
          ).toEqual(['c1', 'c2']);
          expect(
            f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
          ).toEqual(stop === 'pause' ? ['c1', 'c2'] : ['c1', 'c1', 'c2']);
          expect(
            f.modelCalls.find((c) => c.request.stage === 'identity' && c.input.source.chapter.id === 'c2')!.input
              .ledger,
          ).toMatchObject({ throughChapterIndex: 1 });
        } finally {
          heldA2.resolve();
          heldB1.resolve();
          await pending;
          generate.mockRestore();
          await f.cleanup();
        }
      });
    },
  );

  it.each(['429', 'timeout', 'abort'] as const)(
    'settles siblings and saves a completed paid response before surfacing %s, then resumes after lowering concurrency to 1 without duplicating success',
    async (failure) => {
      await withPostgresSchema(harness!, 'speaker_parallel_failure', async (pool) => {
        const f = await setup(pool);
        const held = gate();
        const siblingsStarted = gate();
        let entered = 0;
        let settled = false;
        let failOnce = true;
        const attempts: string[] = [];
        const original = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
          const { input, request } = f.context(args[1]);
          if (request.stage === 'attribution') {
            const chapter = input.source.chapter.id;
            attempts.push(chapter);
            entered++;
            if (entered === 2) siblingsStarted.resolve();
            // This case exercises failures after both requests are dispatched.
            // A synchronous failure before the sibling starts correctly closes admission instead.
            await siblingsStarted.promise;
            if (chapter === 'c1') await held.promise;
            if (chapter === 'c2' && failOnce) {
              failOnce = false;
              if (failure === '429')
                throw Object.assign(connectionError('fixture rate limited', 429), { retryAfterSeconds: 60 });
              if (failure === 'timeout') throw connectionError('fixture timeout', 502);
              throw new DOMException('fixture abort', 'AbortError');
            }
          }
          return original(...args);
        });
        let pending: Promise<boolean> | undefined;
        try {
          await f.engines.save({ ...f.engine, analysisConcurrency: 2, rateLimitRetries: 2 }, f.engine.id);
          const job = await f.create();
          await f.audio.tick();
          pending = f.audio.tick().finally(() => {
            settled = true;
          });
          await vi.waitFor(() => expect(entered).toBe(2));
          expect(settled).toBe(false);
          held.resolve();
          await pending;
          const key = attributionKey(
            (await pool.query('select analysis_key from speaker_generation_runs')).rows[0].analysis_key,
          );
          const rows = (
            await pool.query(
              'select chapter_id,model_response,dispatching,result from speaker_analysis where analysis_key=$1 order by chapter_id',
              [key],
            )
          ).rows;
          expect(rows[0]).toMatchObject({
            chapter_id: 'c1',
            model_response: expect.stringContaining('NEW_1'),
            dispatching: false,
            result: null,
          });
          expect(rows[1]).toMatchObject({ chapter_id: 'c2', model_response: null, dispatching: failure !== '429' });
          const failed = await f.audio.get(job.id);
          expect(failed.status).toBe(failure === '429' ? 'queued' : 'failed');
          const count = generate.mock.calls.length;
          await f.audio.tick();
          expect(generate).toHaveBeenCalledTimes(count);
          // The successful sibling still has an unparsed paid A response when settings change.
          const configured = await f.engines.save(
            { ...f.engine, analysisConcurrency: 1, rateLimitRetries: 2 },
            f.engine.id,
          );
          expect(configured).toMatchObject({ analysisConcurrency: 1, revision: f.engine.revision });
          if (failure === '429')
            await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
          else await f.audio.control(job.id, 'resume', true);
          await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
          expect(attempts.filter((c) => c === 'c1')).toHaveLength(1);
          expect(attempts.filter((c) => c === 'c2')).toHaveLength(2);
          expect(
            f.modelCalls.filter((c) => c.request.stage === 'identity').map((c) => c.input.source.chapter.id),
          ).toEqual(['c1', 'c2']);
        } finally {
          siblingsStarted.resolve();
          held.resolve();
          await pending;
          generate.mockRestore();
          await f.cleanup();
        }
      });
    },
  );

  it.each([0, 2, undefined])(
    'applies %s extra 429 retries to B, retains ready audio, and resumes after exhaustion',
    async (limit) => {
      await withPostgresSchema(harness!, 'speaker_retry_limit', async (pool) => {
        const f = await setup(pool);
        let limits = true;
        let failures = 0;
        const original = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
          const { input, request } = f.context(args[1]);
          if (limits && request.stage === 'identity' && input.source.chapter.id === 'c2') {
            failures++;
            throw Object.assign(connectionError('fixture rate limited', 429), { retryAfterSeconds: 1 });
          }
          return original(...args);
        });
        try {
          await f.engines.save({ ...f.engine, rateLimitRetries: limit }, f.engine.id);
          const job = await f.create();
          await f.until(async () => failures === 1);
          const ready = (
            await pool.query("select ordinal from saved_audiobook_items where audiobook_id=$1 and status='ready'", [
              job.id,
            ])
          ).rows;
          expect(ready).toHaveLength(3);
          const target = limit === undefined ? 4 : limit + 1;
          for (let n = 1; n < target; n++) {
            expect((await f.audio.get(job.id)).status).toBe('queued');
            await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
            await f.audio.tick();
          }
          expect(failures).toBe(target);
          const state = (
            await pool.query(
              'select status,retry_at,rate_limit_attempts,error_message from saved_audiobooks where id=$1',
              [job.id],
            )
          ).rows[0];
          expect(state.status).toBe(limit === undefined ? 'queued' : 'failed');
          expect(state.rate_limit_attempts).toBe(limit ?? target);
          if (limit !== undefined) {
            expect(state.retry_at).toBeNull();
            expect(state.error_message).toContain('이어');
          }
          expect(
            (
              await pool.query("select ordinal from saved_audiobook_items where audiobook_id=$1 and status='ready'", [
                job.id,
              ])
            ).rows,
          ).toEqual(ready);
          limits = false;
          if (limit === undefined)
            await pool.query("update saved_audiobooks set retry_at=now()-interval '1 second' where id=$1", [job.id]);
          else await f.audio.control(job.id, 'resume', true);
          await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
          expect(failures).toBe(target);
          expect(
            (await pool.query('select rate_limit_attempts from saved_audiobooks where id=$1', [job.id])).rows[0]
              .rate_limit_attempts,
          ).toBe(0);
        } finally {
          generate.mockRestore();
          await f.cleanup();
        }
      });
    },
  );

  it('fails an unknown A capability before any paid model dispatch and preserves a legacy serial A when concurrency changes', async () => {
    await withPostgresSchema(harness!, 'speaker_parallel_capability', async (pool) => {
      const f = await setup(pool);
      try {
        await f.engines.save({ ...f.engine, analysisConcurrency: 2 }, f.engine.id);
        f.setCapability(false);
        const job = await f.create();
        await f.audio.tick();
        expect((await f.audio.get(job.id)).status).toBe('failed');
        expect(f.modelCalls).toHaveLength(0);
        await f.engines.save({ ...f.engine, analysisConcurrency: 1 }, f.engine.id);
        await f.audio.control(job.id, 'resume', true);
        await f.audio.tick();
        await f.audio.tick();
        expect(f.modelCalls).toHaveLength(1);
        expect(f.modelCalls[0].request.stage).toBe('attribution');
        await f.engines.save({ ...f.engine, analysisConcurrency: 2 }, f.engine.id);
        f.setCapability(true);
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        expect(
          f.modelCalls.filter((c) => c.request.stage === 'attribution' && c.input.source.chapter.id === 'c1'),
        ).toHaveLength(1);
        const key = attributionKey(
          (await pool.query('select analysis_key from speaker_generation_runs')).rows[0].analysis_key,
        );
        expect(
          (await pool.query("select 1 from speaker_analysis where analysis_key=$1 and chapter_id='c1'", [key]))
            .rowCount,
        ).toBe(0);
      } finally {
        await f.cleanup();
      }
    });
  });

  it.each(['source', 'owner', 'engine'] as const)(
    'fences parallel A response saves after an in-flight %s change',
    async (change) => {
      await withPostgresSchema(harness!, 'speaker_parallel_fence', async (pool) => {
        const f = await setup(pool);
        const held = gate();
        let entered = 0;
        const original = f.engines.transport.generate.bind(f.engines.transport);
        const generate = vi.spyOn(f.engines.transport, 'generate').mockImplementation(async (...args) => {
          entered++;
          await held.promise;
          return original(...args);
        });
        let pending: Promise<boolean> | undefined;
        try {
          await f.engines.save({ ...f.engine, analysisConcurrency: 2 }, f.engine.id);
          const job = await f.create();
          await f.audio.tick();
          pending = f.audio.tick();
          await vi.waitFor(() => expect(entered).toBe(2));
          if (change === 'source')
            await pool.query("update library_books set active_content_revision_id='changed' where id='book'");
          if (change === 'owner') await pool.query("update library_books set user_id='other' where id='book'");
          if (change === 'engine')
            await f.engines.save({ ...f.engine, modelId: 'changed', analysisConcurrency: 2 }, f.engine.id);
          held.resolve();
          await pending;
          expect((await pool.query('select status from saved_audiobooks where id=$1', [job.id])).rows[0].status).toBe(
            'failed',
          );
          expect(
            (
              await pool.query(
                'select count(*)::int n from speaker_analysis where model_response is not null or result is not null',
              )
            ).rows[0].n,
          ).toBe(0);
          expect((await pool.query('select next_chapter from speaker_generation_runs')).rows[0].next_chapter).toBe(0);
          expect(f.synthesize).not.toHaveBeenCalled();
        } finally {
          held.resolve();
          await pending;
          generate.mockRestore();
          await f.cleanup();
        }
      });
    },
  );
});

async function revoiceChoices(f: Awaited<ReturnType<typeof setup>>, id: string): Promise<SpeakerRevoiceInput> {
  return {
    voices: (await f.service.revoiceSource('book', id)).voices.map((v) => ({
      speakerId: v.speakerId,
      voiceId: v.speakerId === 'narrator' ? v.voiceId : 'b',
    })),
  };
}

(harness ? describe : describe.skip)('audio-only revoice of immutable captured speaker plans', () => {
  it('creates a separate idempotent paid variant without engines or casting and preserves original audio and unchanged cache keys', async () => {
    await withPostgresSchema(harness!, 'speaker_revoice_immutable', async (pool) => {
      const f = await setup(pool);
      try {
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const originalJob = (
          await pool.query('select to_jsonb(a) job from saved_audiobooks a where id=$1', [original.id])
        ).rows[0].job;
        const originalItems = (
          await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [original.id])
        ).rows;
        const originalAudio = (await f.audio.audio(original.id, 1)).data;
        const analysis = (await pool.query('select * from speaker_analysis order by analysis_key,chapter_id')).rows;
        const oldRun = (await pool.query('select * from speaker_generation_runs where audiobook_id=$1', [original.id]))
          .rows[0];
        await f.engines.remove(f.engine.id);
        const noAnalysis = vi
          .spyOn(f.engines.transport, 'generate')
          .mockRejectedValue(Error('analysis forbidden during revoice'));
        const noCasting = vi.fn(async () => {
          throw Error('casting forbidden during revoice');
        });
        const service = new SpeakerGenerationService(pool, 'owner', f.engines, f.audio, f.catalog, f.synthesize, {
          select: noCasting,
        } as unknown as SpeakerVoiceCasting);
        const callsBefore = f.requests.length;
        f.catalog.mockResolvedValue({
          ...(await f.catalog()),
          voices: (await f.catalog()).voices.map((v) => ({ ...v, paid: v.id === 'b' })),
        });
        const input = await revoiceChoices(f, original.id);
        expect(input.voices.some((v) => v.speakerId === 'narrator')).toBe(true);
        const estimate = await service.estimateRevoice('book', original.id, input);
        expect(estimate).toMatchObject({ paid: true, itemCount: 6, chapterCount: 2 });
        await expect(service.revoice('book', original.id, input, estimate.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        await expect(service.revoice('book', original.id, input, 'stale-fingerprint', true)).rejects.toMatchObject({
          statusCode: 409,
        });
        const [variant, duplicate] = await Promise.all([
          service.revoice('book', original.id, input, estimate.fingerprint, true),
          service.revoice('book', original.id, input, estimate.fingerprint, true),
        ]);
        expect(variant.id).not.toBe(original.id);
        expect(duplicate.id).toBe(variant.id);
        expect(variant).toMatchObject({ revoiceFrom: original.id, planningComplete: true, itemCount: 6 });
        const seeded = (await pool.query('select * from speaker_generation_runs where audiobook_id=$1', [variant.id]))
          .rows[0];
        expect(seeded).toMatchObject({
          analysis_key: oldRun.analysis_key,
          chapter_ids: oldRun.chapter_ids,
          next_chapter: 2,
          ledger: oldRun.ledger,
          stage: 'audio',
        });
        await f.until(async () => (await f.audio.get(variant.id)).status === 'completed');
        expect(noAnalysis).not.toHaveBeenCalled();
        expect(noCasting).not.toHaveBeenCalled();
        expect(f.requests).toHaveLength(callsBefore);
        expect((await pool.query('select * from speaker_analysis order by analysis_key,chapter_id')).rows).toEqual(
          analysis,
        );
        const items = (
          await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [variant.id])
        ).rows;
        for (const [index, item] of items.entries()) {
          const old = originalItems[index];
          expect(item.request.paragraphHash).toBe(old.request.paragraphHash);
          expect(item.request.chunkHash).toBe(old.request.chunkHash);
          expect(item.request.cast).toEqual(old.request.cast);
          if (old.request.cast.speakerId === 'narrator') {
            expect(item.request).toEqual(old.request);
            expect(item.cache_key).toBe(old.cache_key);
          } else {
            expect(item.request.voiceId).toBe('b');
            expect(item.cache_key).not.toBe(old.cache_key);
          }
        }
        expect(
          (await f.audio.reader('book', 'c1', { id: variant.id }))!.items.map((i) => i.playable.sourceRanges),
        ).toEqual((await f.audio.reader('book', 'c1', { id: original.id }))!.items.map((i) => i.playable.sourceRanges));
        expect(
          (await pool.query('select to_jsonb(a) job from saved_audiobooks a where id=$1', [original.id])).rows[0].job,
        ).toEqual(originalJob);
        expect(
          (
            await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
              original.id,
            ])
          ).rows,
        ).toEqual(originalItems);
        expect((await f.audio.audio(original.id, 1)).data).toEqual(originalAudio);
        expect((await f.audio.audio(variant.id, 1)).data).not.toEqual(originalAudio);
        expect((await pool.query('select count(*)::int n from saved_audiobooks')).rows[0].n).toBe(2);
      } finally {
        await f.cleanup();
      }
    });
  });

  it.each(['paused', 'failed'] as const)(
    'revoices only captured chapters of a %s partial plan and never analyzes the remaining chapter',
    async (status) => {
      await withPostgresSchema(harness!, 'speaker_revoice_partial', async (pool) => {
        const f = await setup(pool);
        try {
          const original = await f.create();
          await f.until(
            async () =>
              (
                await pool.query('select next_chapter from speaker_generation_runs where audiobook_id=$1', [
                  original.id,
                ])
              ).rows[0].next_chapter === 1,
          );
          await pool.query('update saved_audiobooks set status=$2 where id=$1', [original.id, status]);
          const captured = (
            await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
              original.id,
            ])
          ).rows;
          const calls = f.requests.length;
          await f.engines.remove(f.engine.id);
          const input = await revoiceChoices(f, original.id);
          const estimate = await f.service.estimateRevoice('book', original.id, input);
          expect(estimate).toMatchObject({ itemCount: 3, chapterCount: 1 });
          const variant = await f.service.revoice('book', original.id, input, estimate.fingerprint, true);
          expect(variant).toMatchObject({ chapterIds: ['c1'], planningComplete: true });
          expect(
            (
              await pool.query('select chapter_ids,next_chapter from speaker_generation_runs where audiobook_id=$1', [
                variant.id,
              ])
            ).rows[0],
          ).toEqual({ chapter_ids: ['c1'], next_chapter: 1 });
          await f.until(async () => (await f.audio.get(variant.id)).status === 'completed');
          expect(f.requests).toHaveLength(calls);
          expect(
            (await pool.query('select status,planning_complete from saved_audiobooks where id=$1', [original.id]))
              .rows[0],
          ).toEqual({ status, planning_complete: false });
          expect(
            (
              await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
                original.id,
              ])
            ).rows,
          ).toEqual(captured);
          expect(
            (
              await pool.query('select distinct chapter_id from saved_audiobook_items where audiobook_id=$1', [
                variant.id,
              ])
            ).rows,
          ).toEqual([{ chapter_id: 'c1' }]);
        } finally {
          await f.cleanup();
        }
      });
    },
  );

  it('pins per-character instructions in transport and cache identity while preserving source text and voice-only ranges', async () => {
    await withPostgresSchema(harness!, 'speaker_revoice_instructions', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      try {
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const input = await revoiceChoices(f, original.id);
        const character = input.voices.find((v) => v.speakerId !== 'narrator')!;
        const directions = '차분하게 읽되 마지막 말은 단호하게 말하세요.\n본문은 바꾸지 마세요.';
        character.instructions = directions;
        const estimate = await f.service.estimateRevoice('book', original.id, input);
        const variant = await f.service.revoice('book', original.id, input, estimate.fingerprint, true);
        const oldRequests = (
          await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
            original.id,
          ])
        ).rows;
        const items = (
          await pool.query('select ordinal,request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
            variant.id,
          ])
        ).rows;
        const item = items.find((i) => i.request.cast.speakerId === character.speakerId)!;
        const old = oldRequests[item.ordinal].request;
        expect(item.request.cast).toMatchObject({
          instructions: directions,
          start: old.cast.start,
          end: old.cast.end,
          part: old.cast.part,
          speakerId: old.cast.speakerId,
        });
        expect(item.request).toMatchObject({ paragraphHash: old.paragraphHash, chunkHash: old.chunkHash });
        f.synthesize.mockClear();
        const audio = await f.audio.resolve(variant.id, item.ordinal);
        expect(f.synthesize).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          'b',
          item.request.cast.model,
          audio.key,
          false,
          directions,
        );
        expect(f.synthesize.mock.calls[0][0]).not.toContain(directions);
        character.instructions = '낮고 조용하게 읽으세요.';
        const changed = await f.service.estimateRevoice('book', original.id, input);
        expect(changed.fingerprint).not.toBe(estimate.fingerprint);
        const second = await f.service.revoice('book', original.id, input, changed.fingerprint, true);
        const changedAudio = await f.audio.resolve(second.id, item.ordinal);
        expect(changedAudio.key).not.toBe(audio.key);
        expect(await f.service.revoiceSource('book', variant.id).catch(() => undefined)).toBeUndefined(); // queued variants must first be stopped
        await f.audio.control(variant.id, 'pause');
        expect(
          (await f.service.revoiceSource('book', variant.id)).voices.find((v) => v.speakerId === character.speakerId)
            ?.instructions,
        ).toBe(directions);
      } finally {
        await f.cleanup();
      }
    });
  });

  it('rejects incomplete, duplicate, unknown and unsupported voice maps and stale captured source hashes', async () => {
    await withPostgresSchema(harness!, 'speaker_revoice_validation', async (pool) => {
      const f = await setup(pool, 1, ['c1']);
      try {
        const original = await f.create();
        await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
        const input = await revoiceChoices(f, original.id);
        const character = input.voices.find((v) => v.speakerId !== 'narrator')!;
        const originalMap = {
          voices: (await f.service.revoiceSource('book', original.id)).voices.map(({ speakerId, voiceId }) => ({
            speakerId,
            voiceId,
          })),
        };
        const malformed = [
          { voices: [character] },
          { voices: [character, character] },
          {
            voices: input.voices.map((v) => (v.speakerId === character.speakerId ? { ...v, speakerId: 'foreign' } : v)),
          },
          { voices: input.voices.map((v) => ({ ...v, voiceId: 'missing' })) },
          {
            voices: input.voices.map((v) =>
              v.speakerId === character.speakerId ? { ...v, voiceId: 'a', instructions: '연기 지시' } : v,
            ),
          },
          { voices: input.voices.map((v) => ({ ...v, instructions: 'x'.repeat(2001) })) },
          { voices: input.voices.map((v) => ({ ...v, instructions: 'bad\u0000control' })) },
          originalMap,
        ];
        for (const bad of malformed)
          await expect(f.service.estimateRevoice('book', original.id, bad)).rejects.toBeDefined();
        const full = {
          voices: input.voices.map((v) =>
            v.speakerId === character.speakerId ? { ...v, instructions: 'x'.repeat(2000) } : v,
          ),
        };
        await expect(f.service.estimateRevoice('book', original.id, full)).resolves.toMatchObject({ itemCount: 3 });
        await pool.query(
          "update paragraph_search set paragraph=jsonb_set(paragraph,'{text}',to_jsonb('바뀐 본문입니다.'::text)),text='바뀐 본문입니다.' where chapter_id='c1'",
        );
        await expect(f.service.estimateRevoice('book', original.id, input)).rejects.toMatchObject({ statusCode: 409 });
        expect((await pool.query('select count(*)::int n from saved_audiobooks')).rows[0].n).toBe(1);
      } finally {
        await f.cleanup();
      }
    });
  });

  it.each(['owner', 'revision', 'source-status', 'account'] as const)(
    'fences a %s change committed after planning and before immutable variant creation',
    async (change) => {
      await withPostgresSchema(harness!, 'speaker_revoice_fence', async (pool) => {
        const f = await setup(pool, 1, ['c1']);
        let restoreCreate: (() => void) | undefined;
        try {
          const original = await f.create();
          await f.until(async () => (await f.audio.get(original.id)).status === 'completed');
          const input = await revoiceChoices(f, original.id);
          const estimate = await f.service.estimateRevoice('book', original.id, input);
          const actualCreate = f.audio.create.bind(f.audio);
          const create = vi.spyOn(f.audio, 'create').mockImplementationOnce(async (...args) => {
            if (change === 'owner') await pool.query("update library_books set user_id='other' where id='book'");
            if (change === 'revision')
              await pool.query("update library_books set active_content_revision_id='changed' where id='book'");
            if (change === 'source-status')
              await pool.query("update saved_audiobooks set status='queued' where id=$1", [original.id]);
            if (change === 'account')
              await pool.query("update self_host_accounts set role='member' where user_id='owner'");
            return actualCreate(...args);
          });
          restoreCreate = () => create.mockRestore();
          await expect(f.service.revoice('book', original.id, input, estimate.fingerprint, true)).rejects.toMatchObject(
            { statusCode: 409 },
          );
          expect((await pool.query('select count(*)::int n from saved_audiobooks')).rows[0].n).toBe(1);
        } finally {
          restoreCreate?.();
          await f.cleanup();
        }
      });
    },
  );

  it('returns 409 for duplicate library creation without replacing existing metadata and still permits explicit editing', async () => {
    await withPostgresSchema(harness!, 'speaker_revoice_library', async (pool) => {
      const f = await setup(pool);
      try {
        const source = {
          id: 'fixture',
          name: 'Fixture',
          modelId: 'same',
          revision: 'stable',
          synthesisRevision: 'stable',
          paid: false,
          legacyIds: true,
          createProvider: async () => {
            throw Error('metadata edits must not synthesize');
          },
        };
        const catalog = await f.catalog();
        f.catalog.mockResolvedValue({
          ...catalog,
          voices: catalog.voices.map((voice) => ({ ...voice, providerId: source.id })),
        });
        const library = new VoiceLibraryStore(pool, 'owner', async () => [source], f.catalog);
        const metadata = {
          voiceId: 'a',
          alias: '원래 이름',
          timbre: '맑음',
          description: '원래 설명',
          language: 'ko',
          enabled: true,
        };
        const original = await library.save(metadata);
        await expect(
          library.save({ ...metadata, alias: '덮어쓴 이름', description: '중복 요청' }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const saved = (await pool.query('select id,metadata from tts_voice_library where id=$1', [original.id]))
          .rows[0];
        expect(saved).toMatchObject({
          id: original.id,
          metadata: { alias: metadata.alias, description: metadata.description },
        });
        expect((await library.save({ ...metadata, alias: '명시적 수정' }, original.id)).alias).toBe('명시적 수정');
        expect((await pool.query('select count(*)::int n from tts_voice_library')).rows[0].n).toBe(1);
      } finally {
        await f.cleanup();
      }
    });
  });
});

const ACTING_FIXTURE: SpeakerPerformance = {
  emotion: 'sad',
  delivery: 'whispering',
  pace: 'slow',
  intensity: 'subtle',
};
type ActingFixture = Awaited<ReturnType<typeof setup>>;
type ActingPacket = { chapter: string; targets: { id: string; speaker: string; text: string; context: string }[] };
const actingResponse = (packet: ActingPacket) =>
  JSON.stringify({
    performance: packet.targets.map((t) => ({
      id: t.id,
      acting: t.speaker === '내레이터' ? NEUTRAL_PERFORMANCE : ACTING_FIXTURE,
    })),
  });
async function actingFixture(pool: pg.Pool, chapters = ['c1']) {
  const f = await setup(pool, 1, chapters);
  const catalog = await f.catalog();
  f.catalog.mockResolvedValue({
    ...catalog,
    voices: catalog.voices.map((voice) => ({ ...voice, instructionsSupported: true, autoActingSupported: true })),
  });
  const annotations: ActingPacket[] = [];
  const original = f.engines.transport.generateJson.bind(f.engines.transport);
  const generate = vi.spyOn(f.engines.transport, 'generateJson').mockImplementation(async (...args) => {
    if (args[3] !== PERFORMANCE_INSTRUCTION) return original(...args);
    const packet = JSON.parse(args[1].prompt) as ActingPacket;
    annotations.push(packet);
    return actingResponse(packet);
  });
  return { ...f, annotations, annotationSpy: generate };
}
async function actingVariant(f: ActingFixture, original: string) {
  const view = await f.service.revoiceSource('book', original);
  const input: SpeakerRevoiceInput = {
    voices: view.voices.map((v) => ({ speakerId: v.speakerId, voiceId: v.voiceId })),
    acting: { mode: 'auto', engineId: f.engine.id },
  };
  const estimate = await f.service.estimateRevoice('book', original, input);
  return f.service.revoice('book', original, input, estimate.fingerprint, true);
}

(harness ? describe : describe.skip)('automatic acting durable generation', () => {
  it('uses the same fresh A response without an annotation call and keeps analysis identities stable when disabled', async () => {
    await withPostgresSchema(harness!, 'acting_fresh', async (pool) => {
      const f = await actingFixture(pool, ['c1', 'c2']);
      try {
        await f.engines.save({ ...f.engine, analysisConcurrency: 2 }, f.engine.id);
        const job = await f.create({ ...f.input, autoActing: true });
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        expect(f.modelCalls.map((c) => c.request.stage).sort()).toEqual([
          'attribution',
          'attribution',
          'identity',
          'identity',
        ]);
        expect(f.annotations).toHaveLength(0);
        const items = (
          await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [job.id])
        ).rows;
        expect(items.every((i) => !!i.request.cast.performance)).toBe(true);
        expect(
          items
            .filter((i) => i.request.cast.speakerId !== 'narrator')
            .every((i) => i.request.cast.performance.emotion === 'sad'),
        ).toBe(true);
        expect(f.synthesize.mock.calls.every((call) => !call[0].includes('whispering'))).toBe(true);
        expect(f.synthesize.mock.calls.some((call) => call[5] === performanceStyle(ACTING_FIXTURE))).toBe(true);
        const off = await f.create({ ...f.input, autoActing: false, characterVoiceIds: ['b'] });
        await f.until(async () => (await f.audio.get(off.id)).status === 'completed');
        expect(f.modelCalls).toHaveLength(4);
        expect(f.annotations).toHaveLength(0);
        const runs = (
          await pool.query('select analysis_key from speaker_generation_runs where audiobook_id=any($1::uuid[])', [
            [job.id, off.id],
          ])
        ).rows;
        expect(new Set(runs.map((r) => r.analysis_key)).size).toBe(1);
        expect(
          (
            await pool.query(
              "select 1 from saved_audiobook_items where audiobook_id=$1 and request->'cast' ? 'performance'",
              [off.id],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        f.annotationSpy.mockRestore();
        await f.cleanup();
      }
    });
  });

  it('reuses cached untagged A/B across modes and supplements only after the final ordered B', async () => {
    await withPostgresSchema(harness!, 'acting_cached', async (pool) => {
      const f = await actingFixture(pool, ['c1', 'c2']);
      try {
        const old = await f.create();
        await f.until(async () => (await f.audio.get(old.id)).status === 'completed');
        const before = (await pool.query('select * from speaker_analysis order by chapter_id,analysis_key')).rows;
        const modelCalls = f.modelCalls.length;
        const realGenerate = f.annotationSpy.getMockImplementation()!;
        f.annotationSpy.mockImplementation(async (...args) => {
          if (args[3] === PERFORMANCE_INSTRUCTION) {
            expect(
              (await pool.query('select next_chapter from speaker_generation_runs where audiobook_id<>$1', [old.id]))
                .rows[0].next_chapter,
            ).toBe(2);
            expect(f.modelCalls).toHaveLength(modelCalls);
          }
          return realGenerate(...args);
        });
        const next = await f.create({ ...f.input, autoActing: true });
        f.synthesize.mockClear();
        await f.until(async () => (await f.audio.get(next.id)).status === 'completed');
        expect(f.annotations).toHaveLength(2);
        expect(f.annotations.map((a) => a.chapter)).toEqual(['First', 'Second']);
        expect(f.annotations.every((a) => a.targets.length <= 32)).toBe(true);
        expect(f.modelCalls).toHaveLength(modelCalls);
        expect((await pool.query('select * from speaker_analysis order by chapter_id,analysis_key')).rows).toEqual(
          before,
        );
        expect(
          (
            await pool.query(
              "select count(*)::int n from saved_audiobook_items where audiobook_id=$1 and request->'cast' ? 'performance'",
              [next.id],
            )
          ).rows[0].n,
        ).toBe(6);
        expect(
          (
            await pool.query(
              'select count(*)::int n from speaker_voice_decisions where audiobook_id=$1 and decision_key like $2',
              [next.id, 'acting:%'],
            )
          ).rows[0].n,
        ).toBe(2);
      } finally {
        f.annotationSpy.mockRestore();
        await f.cleanup();
      }
    });
  });

  it('annotates old revoice plans using only the selected new engine and includes that analysis in paid confirmation', async () => {
    await withPostgresSchema(harness!, 'acting_revoice_legacy', async (pool) => {
      const f = await actingFixture(pool);
      try {
        const old = await f.create();
        await f.until(async () => (await f.audio.get(old.id)).status === 'completed');
        const source = await f.service.revoiceSource('book', old.id);
        expect(source).toMatchObject({ hasActing: false, needsActing: true });
        const selected = await f.engines.save({ ...f.engine, name: 'Annotation only', modelId: 'annotation-only' });
        await f.engines.remove(f.engine.id);
        const input: SpeakerRevoiceInput = {
          voices: source.voices.map((v) => ({ speakerId: v.speakerId, voiceId: v.voiceId })),
          acting: { mode: 'auto' },
        };
        await expect(f.service.estimateRevoice('book', old.id, input)).rejects.toBeDefined();
        input.acting!.engineId = selected.id;
        const estimate = await f.service.estimateRevoice('book', old.id, input);
        expect(estimate).toMatchObject({ actingAnalysis: true, paid: true });
        await expect(f.service.revoice('book', old.id, input, estimate.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        const before = f.requests.length;
        const job = await f.service.revoice('book', old.id, input, estimate.fingerprint, true);
        await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
        expect(f.annotations).toHaveLength(1);
        const annotation = f.annotationSpy.mock.calls.find((call) => call[3] === PERFORMANCE_INSTRUCTION)!;
        expect(annotation[0].modelId).toBe('annotation-only');
        expect(f.requests).toHaveLength(before);
        expect((await f.audio.get(old.id)).status).toBe('completed');
      } finally {
        f.annotationSpy.mockRestore();
        await f.cleanup();
      }
    });
  });

  it('preserves or drops saved tags without engines and hashes only effective manual or neutral directions', async () => {
    await withPostgresSchema(harness!, 'acting_revoice_modes', async (pool) => {
      const f = await actingFixture(pool);
      try {
        const source = await f.create({ ...f.input, autoActing: true });
        await f.until(async () => (await f.audio.get(source.id)).status === 'completed');
        const view = await f.service.revoiceSource('book', source.id);
        expect(view).toMatchObject({ hasActing: true, needsActing: false });
        await f.engines.remove(f.engine.id);
        const input: SpeakerRevoiceInput = {
          voices: view.voices.map((v) => ({
            speakerId: v.speakerId,
            voiceId: v.voiceId,
            ...(v.speakerId === 'narrator' ? {} : { instructions: '수동 지시를 우선하세요.' }),
          })),
        };
        const preservedEstimate = await f.service.estimateRevoice('book', source.id, input);
        expect(preservedEstimate.actingAnalysis).toBeUndefined();
        const preserved = await f.service.revoice('book', source.id, input, preservedEstimate.fingerprint, true);
        const offInput: SpeakerRevoiceInput = { ...input, acting: { mode: 'off' } };
        const offEstimate = await f.service.estimateRevoice('book', source.id, offInput);
        const off = await f.service.revoice('book', source.id, offInput, offEstimate.fingerprint, true);
        const requests = (
          await pool.query('select ordinal,request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
            preserved.id,
          ])
        ).rows;
        for (const row of requests) {
          const withTags = await f.service.render(preserved.id, row.ordinal, false);
          const withoutTags = await f.service.render(off.id, row.ordinal, false);
          expect(withTags.key).toBe(withoutTags.key);
          if (row.request.cast.speakerId !== 'narrator')
            expect(f.synthesize.mock.calls.at(-1)![5]).toBe('수동 지시를 우선하세요.');
          else expect(f.synthesize.mock.calls.at(-1)![5]).toBeUndefined();
        }
        const allTagged: SpeakerRevoiceInput = {
          voices: view.voices.map((v) => ({ speakerId: v.speakerId, voiceId: 'b' })),
          acting: { mode: 'auto' },
        };
        const estimate = await f.service.estimateRevoice('book', source.id, allTagged);
        expect(estimate.actingAnalysis).toBeUndefined();
        const auto = await f.service.revoice('book', source.id, allTagged, estimate.fingerprint, true);
        await f.until(async () => (await f.audio.get(auto.id)).status === 'completed');
        expect(f.annotations).toHaveLength(0);
        expect(
          (
            await pool.query(
              "select 1 from saved_audiobook_items where audiobook_id=$1 and request->'cast' ? 'performance'",
              [off.id],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        f.annotationSpy.mockRestore();
        await f.cleanup();
      }
    });
  });

  it.each(['pause', '429', 'uncertain', 'rejected'] as const)(
    'persists annotation work through %s without replaying speaker analysis',
    async (failure) => {
      await withPostgresSchema(harness!, 'acting_recovery', async (pool) => {
        const f = await actingFixture(pool);
        const entered = gate();
        const held = gate();
        let pending: Promise<boolean> | undefined;
        let calls = 0;
        let signal: AbortSignal | undefined;
        try {
          const source = await f.create();
          await f.until(async () => (await f.audio.get(source.id)).status === 'completed');
          await f.engines.save({ ...f.engine, rateLimitRetries: 0 }, f.engine.id);
          const original = f.annotationSpy.getMockImplementation()!;
          f.annotationSpy.mockImplementation(async (...args) => {
            if (args[3] !== PERFORMANCE_INSTRUCTION) return original(...args);
            calls++;
            signal = args[2];
            const packet = JSON.parse(args[1].prompt) as ActingPacket;
            if (calls === 1) {
              entered.resolve();
              if (failure === 'pause') await held.promise;
              if (failure === '429')
                throw Object.assign(connectionError('fixture limited', 429), { retryAfterSeconds: 1 });
              if (failure === 'uncertain') throw connectionError('fixture ambiguous timeout', 502);
              if (failure === 'rejected') return JSON.stringify({ performance: [] });
            }
            return actingResponse(packet);
          });
          const job = await actingVariant(f, source.id);
          const before = f.requests.length;
          f.synthesize.mockClear();
          pending = f.audio.tick();
          await entered.promise;
          if (failure === 'pause') {
            await f.audio.control(job.id, 'pause');
            expect(signal?.aborted).toBe(false);
            held.resolve();
          }
          await pending;
          const decision = (
            await pool.query(
              "select response,dispatching,rejected from speaker_voice_decisions where audiobook_id=$1 and decision_key like 'acting:%'",
              [job.id],
            )
          ).rows[0];
          expect((await f.audio.get(job.id)).status).toBe(failure === 'pause' ? 'paused' : 'failed');
          expect(decision.dispatching).toBe(failure === 'uncertain');
          expect(decision.rejected).toBe(failure === 'rejected');
          if (failure === 'pause' || failure === 'rejected') expect(decision.response).toContain('performance');
          else expect(decision.response).toBeNull();
          expect(f.synthesize).not.toHaveBeenCalled();
          await f.audio.tick();
          expect(calls).toBe(1);
          await f.audio.control(job.id, 'resume', true);
          await f.until(async () => (await f.audio.get(job.id)).status === 'completed');
          expect(calls).toBe(failure === 'pause' ? 1 : 2);
          expect(f.requests).toHaveLength(before);
        } finally {
          entered.resolve();
          held.resolve();
          await pending;
          f.annotationSpy.mockRestore();
          await f.cleanup();
        }
      });
    },
  );

  it.each(['owner', 'revision', 'engine'] as const)(
    'rejects a successful annotation after an awaited %s fence changes',
    async (change) => {
      await withPostgresSchema(harness!, 'acting_fence', async (pool) => {
        const f = await actingFixture(pool);
        const entered = gate();
        const held = gate();
        let pending: Promise<boolean> | undefined;
        try {
          const source = await f.create();
          await f.until(async () => (await f.audio.get(source.id)).status === 'completed');
          const original = f.annotationSpy.getMockImplementation()!;
          f.annotationSpy.mockImplementation(async (...args) => {
            if (args[3] !== PERFORMANCE_INSTRUCTION) return original(...args);
            entered.resolve();
            await held.promise;
            return actingResponse(JSON.parse(args[1].prompt) as ActingPacket);
          });
          const job = await actingVariant(f, source.id);
          f.synthesize.mockClear();
          const planned = (
            await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
              job.id,
            ])
          ).rows;
          pending = f.audio.tick();
          await entered.promise;
          if (change === 'owner') await pool.query("update library_books set user_id='other' where id='book'");
          if (change === 'revision')
            await pool.query("update library_books set active_content_revision_id='changed' where id='book'");
          if (change === 'engine') await f.engines.save({ ...f.engine, modelId: 'changed' }, f.engine.id);
          held.resolve();
          await pending;
          expect((await pool.query('select status from saved_audiobooks where id=$1', [job.id])).rows[0].status).toBe(
            'failed',
          );
          expect(
            (
              await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
                job.id,
              ])
            ).rows,
          ).toEqual(planned);
          expect(
            (await pool.query('select response from speaker_voice_decisions where audiobook_id=$1', [job.id])).rows[0]
              .response,
          ).toBeNull();
          expect(f.synthesize).not.toHaveBeenCalled();
        } finally {
          entered.resolve();
          held.resolve();
          await pending;
          f.annotationSpy.mockRestore();
          await f.cleanup();
        }
      });
    },
  );
});
