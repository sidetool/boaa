import { preparedNarrationSession } from '../../../../src/providers/prepared-narration';
import { runTTSPlaybackSession } from '../../../../src/providers/tts-playback-session-runner';
import { loadSpeakerChapter } from './speaker-generation-plan';
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
import { SpeakerEngineTransport } from '../providers/speaker-engine-transport.js';
import { classifyPlainTTSFailure, parsePlainTTSRules } from '../routes/ai/plain-tts-routes.js';
import { registerSpeakerGenerationRoutes } from '../routes/ai/speaker-generation-routes.js';
import { loadConfig } from '../config.js';
import { step, ENGINE_VERSION } from '../../../speaker-engine/src/engine';
import { attribution, identity } from '../../../speaker-engine/src/test-fixtures';
import {
  SPEAKER_ENGINE_PROTOCOL,
  type SpeakerEngineStep,
  type SpeakerEngineResult,
} from '../../../../src/providers/speaker-engine-protocol';
import type { SpeakerGenerationInput } from '../../../../src/providers/speaker-generation';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
async function setup(pool: pg.Pool, concurrency: 1 | 2 = 1) {
  await pool.query(`create table users(id text primary key);create table library_books(id text primary key,user_id text,title text,format text,language text,active_content_revision_id text,deleted_at timestamptz);
 create table chapters(id text primary key,book_id text,title text,chapter_index int);create table paragraph_search(book_id text,chapter_id text,paragraph_id text,paragraph_index int,paragraph jsonb,text text);
 create table self_host_accounts(user_id text,role text,status text);insert into users values('owner'),('other');insert into library_books values('book','owner','Fixture','txt','ko','rev',null);insert into self_host_accounts values('owner','admin','active');
 insert into chapters values('c1','book','First',1),('c2','book','Second',2);`);
  for (const name of [
    '0065_saved_audiobooks.sql',
    '0067_audiobook_retry.sql',
    '0068_speaker_generation.sql',
    '0069_voice_library.sql',
  ])
    await pool.query(await readFile(new URL('../db/migrations/' + name, import.meta.url), 'utf8'));
  for (const id of ['c1', 'c2']) {
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
  const catalog = async () => ({
    available: true,
    revision: 'catalog',
    voices: ['n', 'a', 'b'].map((id) => ({
      id,
      label: id,
      lang: 'ko',
      model: { providerId: 'fixture', modelId: 'same', revision: 'stable' },
      paid: false,
    })),
  });
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
  let last!: SpeakerEngineStep;
  let request!: Extract<SpeakerEngineResult, { kind: 'request' }>;
  let failAccept = false;
  let limited = false;
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const address = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: address, headers: new Headers(init?.headers), body });
    if (address.endsWith('/v1/capabilities'))
      return Response.json({ protocol: SPEAKER_ENGINE_PROTOCOL, engineVersion: ENGINE_VERSION });
    if (address.endsWith('/v1/step')) {
      if (failAccept && body.response) {
        failAccept = false;
        return new Response('temporary', { status: 503 });
      }
      last = body;
      const out = step(last);
      if (out.kind === 'request') request = out;
      return Response.json(out);
    }
    if (address.endsWith('/chat/completions')) {
      if (limited) {
        limited = false;
        return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
      }
      const previous = (last.ledger as { entries?: { workSpeakerId: string }[] } | undefined)?.entries?.[0]
        ?.workSpeakerId;
      const wire = request.stage === 'attribution' ? attribution(last.source) : identity(request, previous);
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
  const synthesize = vi.fn(async (text: string, voiceId: string, _model: unknown, key: string) => ({
    data: Buffer.from(text + '|' + voiceId),
    contentType: 'audio/wav',
    key,
  }));
  const service = new SpeakerGenerationService(pool, 'owner', engines, audio, catalog, synthesize);
  const input: SpeakerGenerationInput = {
    chapterIds: ['c1', 'c2'],
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
    synthesize,
    requests,
    fetchImpl,
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
        expect(f.synthesize.mock.calls.map((c) => c[1])).toEqual(['n', 'a', 'n', 'n', 'a', 'n']);
        const modelCalls = () => f.requests.filter((r) => r.url.endsWith('/chat/completions')).length;
        expect(modelCalls()).toBe(4);
        const second = await f.create({ ...f.input, characterVoiceIds: ['b'] });
        await f.until(
          async () => (await f.service.list('book')).find((j) => j.id === second.id)?.status === 'completed',
        );
        expect(modelCalls()).toBe(4);
        expect(f.synthesize.mock.calls.slice(6).map((c) => c[1])).toEqual(['n', 'b', 'n', 'n', 'b', 'n']);
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
        expect(Number((await pool.query('select count(*) n from speaker_analysis')).rows[0].n)).toBe(0);
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
