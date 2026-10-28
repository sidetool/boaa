import { planSpeakerRevoice } from './speaker-revoice-plan';
import { applyBookVoiceUpdates, bookBindingVersions } from './speaker-book-voices';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { textIntegrityHash } from '@boaa/text-core/hash';
import type pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
import type { PlainTTSModel, PlainTTSVoices } from '../../../../src/providers/plain-tts';
import type { SpeakerChapter, SpeakerEngineResult } from '../../../../src/providers/speaker-engine-protocol';
import type { SpeakerGenerationInput, SpeakerGenerationSettings } from '../../../../src/providers/speaker-generation';
import type { VoiceDesignInput, VoiceLibraryInput } from '../../../../src/providers/voice-library';
import type { TTSSynthesisProvider } from '../../../../src/providers/tts';
import { loadConfig } from '../config';
import { castingRevision, speakerRevision } from '../providers/speaker-engine-config';
import { SpeakerEngineStore } from '../providers/speaker-engine-store';
import { SpeakerEngineTransport } from '../providers/speaker-engine-transport';
import type { PlainTTSSource } from '../providers/plain-tts-sources';
import { wavFromPcm16 } from '../providers/tts-audio';
import { VoiceLibraryStore, voiceSourceModel } from './voice-library-store';
import { SpeakerVoiceCasting, type CastingRun } from './speaker-voice-casting';
import { castRequests, type CastRequest } from './speaker-generation-plan';
import { AudiobookService } from './audiobook-service';
import { AudiobookAudioStore } from './audiobook-audio';
import { SpeakerGenerationService } from './speaker-generation-service';
import { classifyPlainTTSFailure } from '../routes/ai/plain-tts-routes';
import { ENGINE_VERSION } from '../../../speaker-engine/src/engine';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from './id-v2-migration/postgres-integration-harness';

// Local verification requires an explicitly owned PG; CI uses the standard repository harness.
const harness =
  process.env.BOAA_TEST_DATABASE_URL || process.env.CI ? await startPostgresIntegrationHarness() : undefined;
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
const signal = () => new AbortController().signal;
const sample = wavFromPcm16(Buffer.from([0, 0, 1, 0]), 24000);
const metadata = (voiceId = 'local:a'): VoiceLibraryInput => ({
  voiceId,
  alias: '합성 목소리',
  timbre: '따뜻함',
  description: '차분하고 또렷한 목소리',
  language: 'ko',
  enabled: true,
});
const designInput = (requestId = 'fixture_request_0001'): VoiceDesignInput => ({
  requestId,
  providerId: 'designer',
  modelId: 'selected-design-model',
  alias: '새 목소리',
  prompt: '차분하고 따뜻한 원래 인물의 목소리',
  language: 'ko',
  confirmPaid: true,
});
const chapter: SpeakerChapter = {
  id: 'chapter',
  index: 1,
  title: '합성 회차',
  paragraphs: [
    { id: 'p1', index: 1, text: '민아가 말했다. “안녕.”' },
    { id: 'p2', index: 2, text: '손님이 답했다. “반가워.”' },
  ],
};
function completed(ids = ['speaker-one']): Extract<SpeakerEngineResult, { kind: 'complete' }> {
  return {
    kind: 'complete',
    ledger: {},
    identities: ids.map((id, i) => ({ id, name: i ? '손님' : '민아', reviewRequired: false })),
    labels: ids.map((id, i) => ({
      paragraphId: chapter.paragraphs[i % 2].id,
      startOffset: 0,
      endOffset: chapter.paragraphs[i % 2].text.length,
      textHash: 'not-used-by-casting',
      speakerId: id,
      reviewRequired: false,
    })),
  };
}

async function setup(pool: pg.Pool, natural = false) {
  await pool.query(`create table users(id text primary key);
    create table library_books(id text primary key,user_id text,title text,format text,language text,active_content_revision_id text,deleted_at timestamptz);
    create table self_host_accounts(user_id text primary key,role text,status text);
    create table chapters(id text primary key,book_id text,title text,chapter_index integer);
    create table paragraph_search(book_id text,chapter_id text,paragraph_id text,paragraph_index integer,paragraph jsonb,text text);
    insert into users values('owner'),('other');
    insert into self_host_accounts values('owner','admin','active'),('other','admin','active');
    insert into library_books values('book','owner','Fixture','txt','ko','revision',null),('book-two','owner','Other fixture','txt','ko','revision',null),('foreign-book','other','Private fixture','txt','ko','revision',null)`);
  for (const migration of [
    '0065_saved_audiobooks.sql',
    '0067_audiobook_retry.sql',
    '0068_speaker_generation.sql',
    '0069_voice_library.sql',
  ])
    await pool.query(await readFile(new URL('../db/migrations/' + migration, import.meta.url), 'utf8'));
  await pool.query('insert into chapters values($1,$2,$3,1)', [chapter.id, 'book', chapter.title]);
  for (const p of chapter.paragraphs) {
    const paragraph = {
      ...p,
      chapterId: chapter.id,
      novelId: 'book',
      textHash: textIntegrityHash(p.text),
      startOffsetInChapter: 0,
      endOffsetInChapter: p.text.length,
    };
    await pool.query('insert into paragraph_search values($1,$2,$3,$4,$5,$6)', [
      'book',
      chapter.id,
      p.id,
      p.index,
      paragraph,
      p.text,
    ]);
  }

  let sequence = 0;
  const design = vi.fn<NonNullable<TTSSynthesisProvider['designVoice']>>(async () => ({
    id: 'voice_created_' + ++sequence,
    sample: { data: sample, contentType: 'audio/wav' },
  }));
  const synthesize = vi.fn<TTSSynthesisProvider['synthesize']>(async () => {
    throw Error('unexpected synthesis');
  });
  const localProvider: TTSSynthesisProvider = {
    providerId: 'fixture-local',
    displayName: 'Local fixture',
    supportsStreaming: false,
    supportsAudioCache: true,
    supportsPerCharacterVoice: true,
    synthesize,
  };
  const designerProvider: TTSSynthesisProvider = { ...localProvider, providerId: 'gemini-tts', designVoice: design };
  const local: PlainTTSSource = {
    id: 'local',
    name: 'Local fixture',
    modelId: 'local-model',
    revision: 'catalog-local',
    synthesisRevision: 'synthesis-local',
    paid: false,
    createProvider: async () => localProvider,
  };
  const designer: PlainTTSSource = {
    id: 'designer',
    name: 'Design fixture',
    modelId: natural ? 'gemini-3.8-flash-tts' : 'synthesis-model',
    revision: 'catalog-designer',
    synthesisRevision: 'synthesis-designer',
    paid: true,
    createProvider: async () => designerProvider,
  };
  const sources = async () => [local, designer];
  const catalog = async (): Promise<PlainTTSVoices> => {
    const voices: PlainTTSVoices['voices'] = ['n', 'a', 'b'].map((id) => ({
      id: 'local:' + id,
      label: id,
      lang: 'ko',
      providerId: local.id,
      model: voiceSourceModel(local),
      paid: false,
    }));
    voices.push({
      id: 'designer:preset',
      label: 'Preset',
      lang: 'ko',
      providerId: designer.id,
      model: voiceSourceModel(designer),
      autoActingSupported: natural,
      instructionsSupported: natural,
      paid: true,
    });
    const rows = (
      await pool.query(
        "select voice_id,provider_id,model,metadata from tts_voice_library where user_id='owner' and origin='designed'",
      )
    ).rows;
    for (const row of rows)
      voices.push({
        id: row.voice_id,
        label: row.metadata.alias,
        lang: row.metadata.language,
        providerId: row.provider_id,
        model: row.model,
        paid: true,
      });
    return { available: true, revision: 'catalog', voices };
  };
  const library = new VoiceLibraryStore(pool, 'owner', sources, catalog);
  const otherLibrary = new VoiceLibraryStore(pool, 'other', sources, catalog);
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw Error('unexpected real model request');
  });
  const transport = new SpeakerEngineTransport({
    fetchImpl,
    lookup: async () => [{ address: '192.168.1.10', family: 4 }],
  });
  const engines = new SpeakerEngineStore(
    pool,
    loadConfig({ DEFAULT_USER_ID: 'owner' }),
    { PROVIDER_SECRET_ENCRYPTION_KEY: '11'.repeat(32) },
    transport,
  );
  const engine = await engines.save({
    purpose: 'casting',
    name: 'Independent casting',
    engineUrl: 'http://unused-analysis.invalid',
    protocol: 'openai',
    url: 'http://model.invalid/v1',
    modelId: 'chosen-casting-model',
    maxOutputTokens: 4096,
    enabled: true,
    paid: true,
  });
  const generate = vi.spyOn(transport, 'generateJson').mockImplementation(async (_engine, request) => {
    const data = JSON.parse(request.prompt) as { characters: { id: string; name: string }[] };
    return JSON.stringify({
      assignments: data.characters.map((c) => ({
        speakerId: c.id,
        voiceId: 'local:a',
        importance: 'extra',
        alias: c.name,
        timbre: '중립',
        description: '',
        designPrompt: '',
      })),
    });
  });
  const casting = new SpeakerVoiceCasting(pool, 'owner', library, engines, catalog);
  const options = async (autoDesign = false): Promise<NonNullable<SpeakerGenerationSettings['casting']>> => ({
    engineId: engine.id,
    engineRevision: castingRevision(await engines.loadCasting(engine.id)),
    autoDesign,
    maxDesignedVoices: autoDesign ? 1 : 0,
    ...(autoDesign
      ? {
          designProviderId: designer.id,
          designModelId: natural ? 'gemini-3.8-flash-tts' : 'selected-design-model',
          designModel: voiceSourceModel(designer),
        }
      : {}),
  });
  const run = async (
    input: {
      bookId?: string;
      analysisKey?: string;
      pool?: string[];
      casting?: SpeakerGenerationSettings['casting'];
      assignments?: Record<string, string>;
    } = {},
  ): Promise<CastingRun> => {
    const settings: AudiobookInput = {
      chapterIds: ['chapter'],
      voiceId: 'local:n',
      modelRevision: 'catalog',
      chunking: 'paragraph',
      footnotePlayback: 'skip',
      rules: [],
      cast: {
        language: 'ko',
        engineId: 'analysis-fixture',
        engineRevision: 'analysis-revision',
        engineVersion: 'preset35-boaa-2',
        characterVoiceIds: input.pool ?? ['local:a', 'local:b'],
        models: Object.fromEntries(
          (await catalog()).voices
            .filter((v) => v.id === 'local:n' || (input.pool ?? ['local:a', 'local:b']).includes(v.id))
            .map((v) => [v.id, v.model!]),
        ),
        casting: input.casting,
      },
    };
    const value: CastingRun = {
      id: randomUUID(),
      book_id: input.bookId ?? 'book',
      analysis_key: input.analysisKey ?? 'analysis-one',
      content_revision: 'revision',
      settings,
      assignments: input.assignments ?? {},
    };
    await pool.query(
      `insert into saved_audiobooks(id,user_id,book_id,content_revision,fingerprint,title,settings,estimate,status,total_items)
      values($1,'owner',$2,'revision',$3,'Fixture',$4,'{}','running',0)`,
      [value.id, value.book_id, randomUUID(), settings],
    );
    await pool.query(
      'insert into speaker_generation_runs(audiobook_id,analysis_key,chapter_ids,assignments) values($1,$2,$3,$4)',
      [value.id, value.analysis_key, JSON.stringify(['chapter']), value.assignments],
    );
    return value;
  };
  return {
    pool,
    library,
    otherLibrary,
    local,
    designer,
    sources,
    catalog,
    design,
    synthesize,
    engines,
    engine,
    transport,
    generate,
    fetchImpl,
    casting,
    options,
    run,
  };
}

async function serviceFixture(f: Awaited<ReturnType<typeof setup>>) {
  const failures: unknown[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-voice-library-'));
  const render = vi.fn(async (text: string, voiceId: string, _model: PlainTTSModel, key: string) => ({
    data: Buffer.from(text + '|' + voiceId),
    contentType: 'audio/wav',
    key,
  }));
  const audio = new AudiobookService(
    f.pool,
    'owner',
    new AudiobookAudioStore(directory),
    f.catalog,
    async () => {
      throw Error('ordinary synthesis forbidden');
    },
    (error) => {
      failures.push(error);
      return classifyPlainTTSFailure(error);
    },
  );
  const service = new SpeakerGenerationService(f.pool, 'owner', f.engines, audio, f.catalog, render, f.casting);
  const untilCompleted = async (id: string) => {
    for (let n = 0; n < 30; n++) {
      const job = await audio.get(id);
      if (job.status === 'completed') return;
      if (job.status === 'failed')
        throw new Error('Voice workflow failed: ' + String(failures.at(-1)), { cause: failures.at(-1) });
      await audio.tick();
    }
    throw Error('voice library test did not finish within bounded ticks');
  };
  return {
    audio,
    service,
    render,
    untilCompleted,
    cleanup: async () => {
      await audio.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

(harness ? describe : describe.skip)('owned voice library and durable speaker casting', () => {
  it('persists editable metadata while keeping voice and synthesis model immutable and isolating owners', async () => {
    await withPostgresSchema(harness!, 'voice_metadata', async (pool) => {
      const f = await setup(pool);
      const original = await f.library.save(metadata());
      const updated = await f.library.save(
        {
          ...metadata(),
          alias: '새 별칭',
          timbre: '낮고 따뜻함',
          description: '수정한 설명',
          language: 'en-US',
          enabled: false,
        },
        original.id,
      );
      expect(updated).toMatchObject({
        id: original.id,
        voiceId: original.voiceId,
        providerVoiceId: 'a',
        model: original.model,
        alias: '새 별칭',
        timbre: '낮고 따뜻함',
        description: '수정한 설명',
        language: 'en-US',
        enabled: false,
      });
      const fresh = new VoiceLibraryStore(pool, 'owner', f.sources, f.catalog);
      expect((await fresh.list()).voices).toEqual([updated]);
      await expect(f.library.save(metadata())).rejects.toMatchObject({ statusCode: 409 });
      expect((await fresh.list()).voices).toEqual([updated]);
      await expect(f.library.save(metadata('local:b'), original.id)).rejects.toMatchObject({ statusCode: 400 });
      await expect(f.otherLibrary.save(metadata(), original.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.otherLibrary.sample(original.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(f.otherLibrary.remove(original.id)).rejects.toMatchObject({ statusCode: 404 });
      const other = await f.otherLibrary.save(metadata());
      expect(other.id).not.toBe(original.id);
      expect((await f.otherLibrary.list()).voices.map((v) => v.id)).toEqual([other.id]);
      f.local.modelId = 'changed-synthesis-model';
      expect((await fresh.list()).voices[0]).toMatchObject({ model: original.model, available: false });
      expect(f.design).not.toHaveBeenCalled();
      expect(f.synthesize).not.toHaveBeenCalled();
    });
  });

  it('reports real design capabilities, requires paid consent and reuses a stored request across fresh stores', async () => {
    await withPostgresSchema(harness!, 'voice_design_saved', async (pool) => {
      const f = await setup(pool);
      expect((await f.library.list()).designers).toEqual([
        {
          id: 'designer',
          name: 'Design fixture',
          modelId: 'synthesis-model',
          paid: true,
        },
      ]);
      await expect(f.library.design({ ...designInput(), providerId: 'local' }, signal())).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(f.library.design({ ...designInput(), confirmPaid: false }, signal())).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(f.design).not.toHaveBeenCalled();
      const created = await f.library.design(designInput(), signal());
      expect(created).toMatchObject({
        voiceId: 'designer:voice_created_1',
        providerVoiceId: 'voice_created_1',
        origin: 'designed',
        model: voiceSourceModel(f.designer),
        sampleAvailable: true,
      });
      const fresh = new VoiceLibraryStore(pool, 'owner', f.sources, f.catalog);
      expect(await fresh.design(designInput(), signal())).toEqual(created);
      expect(f.design).toHaveBeenCalledTimes(1);
      expect((await fresh.sample(created.id)).audio).toEqual({ data: sample, contentType: 'audio/wav' });
      await expect(fresh.design({ ...designInput(), prompt: 'changed' }, signal())).rejects.toMatchObject({
        statusCode: 409,
      });
      await fresh.remove(created.id);
      await expect(fresh.design(designInput(), signal())).rejects.toMatchObject({ statusCode: 409 });
      expect(f.design).toHaveBeenCalledTimes(1);
    });
  });

  it('retries only a known 429 on the same durable request and blocks ambiguous paid replay', async () => {
    await withPostgresSchema(harness!, 'voice_design_retry', async (pool) => {
      const f = await setup(pool);
      f.design.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429, retryAfterSeconds: 20 }));
      await expect(f.library.design(designInput(), signal())).rejects.toMatchObject({ status: 429 });
      expect((await pool.query('select status from tts_voice_designs')).rows[0].status).toBe('retry');
      const fresh = new VoiceLibraryStore(pool, 'owner', f.sources, f.catalog);
      await fresh.design(designInput(), signal());
      expect(f.design).toHaveBeenCalledTimes(2);
      f.design.mockRejectedValueOnce(new Error('response lost after dispatch'));
      const uncertain = designInput('fixture_request_unknown');
      await expect(fresh.design(uncertain, signal())).rejects.toThrow('response lost');
      expect(
        (await pool.query('select status from tts_voice_designs where request_id=$1', [uncertain.requestId])).rows[0]
          .status,
      ).toBe('uncertain');
      await expect(fresh.design(uncertain, signal())).rejects.toMatchObject({ statusCode: 409 });
      expect(f.design).toHaveBeenCalledTimes(3);
    });
  });

  it('serializes duplicate in-flight request IDs without dispatching a second paid creation', async () => {
    await withPostgresSchema(harness!, 'voice_design_concurrency', async (pool) => {
      const f = await setup(pool);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.design.mockImplementationOnce(async () => {
        entered();
        await gate;
        return { id: 'voice_once' };
      });
      const pending = f.library.design(designInput(), signal());
      try {
        await started;
        await expect(f.library.design(designInput(), signal())).rejects.toMatchObject({ statusCode: 409 });
        expect(f.design).toHaveBeenCalledTimes(1);
        release();
        const value = await pending;
        expect(await f.library.design(designInput(), signal())).toEqual(value);
        expect(f.design).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await pending;
      }
    });
  });

  it('enforces library capacity before paid creation while permitting metadata edits at capacity', async () => {
    await withPostgresSchema(harness!, 'voice_library_quota', async (pool) => {
      const f = await setup(pool);
      await pool.query(
        `insert into tts_voice_library(id,user_id,voice_id,provider_id,provider_voice_id,model,metadata,origin)
        select md5(i::text)::uuid,'owner','local:quota-'||i,'local','quota-'||i,$1,$2,'catalog' from generate_series(1,256) i`,
        [voiceSourceModel(f.local), metadata()],
      );
      await expect(f.library.save(metadata())).rejects.toMatchObject({ statusCode: 409 });
      await expect(f.library.design(designInput(), signal())).rejects.toMatchObject({ statusCode: 413 });
      expect(f.design).not.toHaveBeenCalled();
      const old = (await f.library.list()).voices[0];
      expect(await f.library.save({ ...metadata(old.voiceId), alias: '수정 가능' }, old.id)).toMatchObject({
        alias: '수정 가능',
        model: old.model,
      });
      expect(Number((await pool.query('select count(*) n from tts_voice_library')).rows[0].n)).toBe(256);
    });
  });

  it('enforces the 64 MiB sample quota and two concurrent paid-design limit before dispatch', async () => {
    await withPostgresSchema(harness!, 'voice_sample_concurrency_quota', async (pool) => {
      const f = await setup(pool);
      // Compressed synthetic bytea rows exercise real DB byte accounting without fetching large samples.
      await pool.query(
        `insert into tts_voice_library(id,user_id,voice_id,provider_id,provider_voice_id,model,metadata,origin,sample,sample_type)
        select md5(i::text)::uuid,'owner','designer:quota-'||i,'designer','quota-'||i,$1,$2,'designed',repeat('x',4194304)::bytea,'audio/wav' from generate_series(1,16) i`,
        [voiceSourceModel(f.designer), metadata()],
      );
      expect(Number((await pool.query('select sum(octet_length(sample)) n from tts_voice_library')).rows[0].n)).toBe(
        64 * 1024 * 1024,
      );
      await expect(f.library.design(designInput(), signal())).rejects.toMatchObject({ statusCode: 413 });
      expect(f.design).not.toHaveBeenCalled();
      await pool.query('delete from tts_voice_library');
      await pool.query(
        "insert into tts_voice_designs(user_id,request_id,input_hash,status) values('owner','fixture_pending_first','fixture','dispatching'),('owner','fixture_pending_second','fixture','dispatching')",
      );
      await expect(f.library.design(designInput(), signal())).rejects.toMatchObject({ statusCode: 429 });
      expect(f.design).not.toHaveBeenCalled();
    });
  }, 15_000);

  it('rejects oversized adapter samples and fences account or source changes after paid generation', async () => {
    await withPostgresSchema(harness!, 'voice_design_fences', async (pool) => {
      const f = await setup(pool);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(f.library.design(designInput(), cancelled.signal)).rejects.toThrow();
      expect(f.design).not.toHaveBeenCalled();
      f.design.mockResolvedValueOnce({
        id: 'voice_too_large',
        sample: { data: new Uint8Array(4 * 1024 * 1024 + 1), contentType: 'audio/wav' },
      });
      await expect(f.library.design(designInput('fixture_request_large'), signal())).rejects.toMatchObject({
        statusCode: 502,
      });
      await expect(f.library.design(designInput('fixture_request_large'), signal())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(f.design).toHaveBeenCalledTimes(1);
      f.design.mockImplementationOnce(async () => {
        await pool.query("update self_host_accounts set status='disabled' where user_id='owner'");
        return { id: 'voice_revoked' };
      });
      await expect(f.library.design(designInput('fixture_request_revoked'), signal())).rejects.toMatchObject({
        statusCode: 403,
      });
      expect((await pool.query('select count(*)::int n from tts_voice_library')).rows[0].n).toBe(0);
    });
  });

  it('fences a synthesis-model change after paid generation before saving the new voice', async () => {
    await withPostgresSchema(harness!, 'voice_design_source_fence', async (pool) => {
      const f = await setup(pool);
      f.design.mockImplementationOnce(async () => {
        f.designer.synthesisRevision = 'changed-after-await';
        return { id: 'voice_stale_model' };
      });
      await expect(f.library.design(designInput('fixture_request_model'), signal())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect((await pool.query('select count(*)::int n from tts_voice_library')).rows[0].n).toBe(0);
    });
  });

  it('keeps stable book and identity-namespace bindings across jobs, pool order changes and explicit pinning', async () => {
    await withPostgresSchema(harness!, 'voice_bindings', async (pool) => {
      const f = await setup(pool);
      await f.library.save(metadata('local:a'));
      await f.library.save(metadata('local:b'));
      const first = await f.run();
      const selected = await f.casting.select(first, chapter, completed(), signal());
      if (!selected) throw Error('expected selected voice');
      const old = selected.assignments['speaker-one'];
      await pool.query(
        'insert into saved_audiobook_items(audiobook_id,ordinal,chapter_id,chapter_title,request) values($1,0,$2,$3,$4)',
        [first.id, chapter.id, chapter.title, { voiceId: old }],
      );
      const alternate = old === 'local:a' ? 'local:b' : 'local:a';
      await expect(f.casting.assign(first, 'speaker-one', alternate)).rejects.toMatchObject({ statusCode: 409 });
      await pool.query("update saved_audiobooks set status='paused' where id=$1", [first.id]);
      await f.casting.assign(first, 'speaker-one', alternate);
      expect(
        (await pool.query('select request from saved_audiobook_items where audiobook_id=$1', [first.id])).rows[0]
          .request.voiceId,
      ).toBe(old);
      const second = await f.run({ pool: ['local:b', 'local:a'] });
      const fresh = new SpeakerVoiceCasting(pool, 'owner', f.library, f.engines, f.catalog);
      expect((await fresh.select(second, chapter, completed(), signal()))?.assignments['speaker-one']).toBe(alternate);
      expect((await fresh.list(second))[0]).toMatchObject({ voiceId: alternate, pinned: true });
      const bound = (await f.library.list()).voices.find((v) => v.voiceId === alternate)!;
      await expect(f.library.remove(bound.id)).rejects.toMatchObject({ statusCode: 409 });
      await fresh.select(await f.run({ analysisKey: 'analysis-two' }), chapter, completed(), signal());
      await fresh.select(await f.run({ bookId: 'book-two' }), chapter, completed(), signal());
      expect((await pool.query('select count(*)::int n from speaker_voice_bindings')).rows[0].n).toBe(3);
      const other = new SpeakerVoiceCasting(pool, 'other', f.otherLibrary, f.engines, f.catalog);
      await expect(other.list(second)).rejects.toMatchObject({ statusCode: 409 });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.design).not.toHaveBeenCalled();
    });
  });

  it('requires a casting-purpose connection and ignores analysis-service URL changes in the casting revision', async () => {
    await withPostgresSchema(harness!, 'voice_selection_purpose', async (pool) => {
      const f = await setup(pool);
      const old = await f.engines.loadCasting(f.engine.id);
      const revision = castingRevision(old);
      await f.engines.save({ ...old, engineUrl: 'http://moved-analysis.invalid' }, f.engine.id);
      expect(castingRevision(await f.engines.loadCasting(f.engine.id, revision))).toBe(revision);
      expect(speakerRevision(await f.engines.loadCasting(f.engine.id))).not.toBe(speakerRevision(old));
      const analysis = await f.engines.save({ ...old, purpose: 'analysis', name: 'Analysis only' });
      await expect(f.engines.loadCasting(analysis.id)).rejects.toThrow();
      const changed = await f.engines.save({ ...old, modelId: 'changed-casting-model' }, f.engine.id);
      expect(changed.modelId).toBe('changed-casting-model');
      await expect(f.engines.loadCasting(f.engine.id, revision)).rejects.toMatchObject({ statusCode: 409 });
      expect(f.fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('persists model replies before binding acceptance, reuses them after failure and never invents provider IDs', async () => {
    await withPostgresSchema(harness!, 'voice_selection_checkpoint', async (pool) => {
      const f = await setup(pool);
      const run = await f.run({ casting: await f.options() });
      const source = vi
        .spyOn(f.library, 'source')
        .mockRejectedValueOnce(Object.assign(new Error('source temporarily unavailable'), { statusCode: 502 }));
      await expect(f.casting.select(run, chapter, completed(), signal())).rejects.toThrow('temporarily unavailable');
      source.mockRestore();
      expect((await pool.query('select response,dispatching from speaker_voice_decisions')).rows[0]).toMatchObject({
        response: expect.any(String),
        dispatching: false,
      });
      await f.casting.select(run, chapter, completed(), signal());
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query('select count(*)::int n from speaker_voice_decisions where audiobook_id=$1', [run.id]))
          .rows[0].n,
      ).toBe(0);
      const invalid = await f.run({ analysisKey: 'invalid-analysis', casting: await f.options() });
      f.generate.mockResolvedValueOnce(
        JSON.stringify({
          assignments: [
            {
              speakerId: 'speaker-one',
              voiceId: 'voice_invented',
              importance: 'extra',
              alias: '',
              timbre: '',
              description: '',
              designPrompt: '',
            },
          ],
        }),
      );
      await expect(f.casting.select(invalid, chapter, completed(), signal())).rejects.toMatchObject({
        statusCode: 502,
      });
      await expect(f.casting.select(invalid, chapter, completed(), signal())).rejects.toMatchObject({
        statusCode: 502,
      });
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.design).not.toHaveBeenCalled();
      expect(
        (await pool.query('select rejected from speaker_voice_decisions where audiobook_id=$1', [invalid.id])).rows[0]
          .rejected,
      ).toBe(true);
    });
  });

  it('clears a known selection 429 checkpoint but blocks unknown automatic replay and fences an owner change', async () => {
    await withPostgresSchema(harness!, 'voice_selection_retry', async (pool) => {
      const f = await setup(pool);
      const run = await f.run({ casting: await f.options() });
      f.generate.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }));
      await expect(f.casting.select(run, chapter, completed(), signal())).rejects.toMatchObject({ statusCode: 429 });
      expect((await pool.query('select dispatching from speaker_voice_decisions')).rows[0].dispatching).toBe(false);
      await f.casting.select(run, chapter, completed(), signal());
      expect(f.generate).toHaveBeenCalledTimes(2);
      const ambiguous = await f.run({ analysisKey: 'ambiguous', casting: await f.options() });
      f.generate.mockRejectedValueOnce(new Error('lost reply'));
      await expect(f.casting.select(ambiguous, chapter, completed(), signal())).rejects.toThrow('lost reply');
      await expect(f.casting.select(ambiguous, chapter, completed(), signal())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(f.generate).toHaveBeenCalledTimes(3);
      const revoked = await f.run({ analysisKey: 'revoked', casting: await f.options() });
      const implementation = f.generate.getMockImplementation()!;
      f.generate.mockImplementationOnce(async (...args) => {
        await pool.query("update library_books set user_id='other' where id='book'");
        return implementation(...args);
      });
      await expect(f.casting.select(revoked, chapter, completed(), signal())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(
        (await pool.query('select response from speaker_voice_decisions where audiobook_id=$1', [revoked.id])).rows[0]
          .response,
      ).toBeNull();
      expect(
        (
          await pool.query('select count(*)::int n from speaker_voice_bindings where analysis_key=$1', [
            revoked.analysis_key,
          ])
        ).rows[0].n,
      ).toBe(0);
    });
  });

  it('reuses a paid designed voice after a partial casting failure and in a new job without another creation', async () => {
    await withPostgresSchema(harness!, 'voice_design_cast_checkpoint', async (pool) => {
      const f = await setup(pool);
      const run = await f.run({ casting: await f.options(true) });
      f.generate.mockResolvedValue(
        JSON.stringify({
          assignments: [
            {
              speakerId: 'speaker-one',
              voiceId: 'local:a',
              importance: 'major',
              alias: '민아',
              timbre: '따뜻함',
              description: '주요 인물',
              designPrompt: '차분한 원래 인물의 목소리',
            },
          ],
        }),
      );
      const original = f.library.source.bind(f.library);
      const source = vi.spyOn(f.library, 'source').mockImplementation(async (id, model) => {
        if (
          f.design.mock.calls.length === 1 &&
          model &&
          id === 'designer' &&
          (await pool.query("select 1 from tts_voice_designs where status='ready'")).rowCount
        ) {
          source.mockRestore();
          throw Object.assign(new Error('fail after paid voice stored'), { statusCode: 502 });
        }
        return original(id, model);
      });
      await expect(f.casting.select(run, chapter, completed(), signal())).rejects.toThrow('after paid voice stored');
      expect((await pool.query('select status from tts_voice_designs')).rows[0].status).toBe('ready');
      const selected = await f.casting.select(run, chapter, completed(), signal());
      expect(selected?.assignments['speaker-one']).toBe('designer:voice_created_1');
      expect(f.design).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
      const next = await f.run({ casting: await f.options(true) });
      expect((await f.casting.select(next, chapter, completed(), signal()))?.assignments['speaker-one']).toBe(
        'designer:voice_created_1',
      );
      expect(f.design).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
    });
  });

  it('caps new designs at the pinned job budget and keeps existing fallback IDs for remaining major characters', async () => {
    await withPostgresSchema(harness!, 'voice_design_job_budget', async (pool) => {
      const f = await setup(pool);
      const run = await f.run({ casting: await f.options(true) });
      f.generate.mockResolvedValue(
        JSON.stringify({
          assignments: ['speaker-one', 'speaker-two'].map((speakerId) => ({
            speakerId,
            voiceId: 'local:a',
            importance: 'major',
            alias: speakerId,
            timbre: '',
            description: '',
            designPrompt: '차분한 원래 인물의 목소리',
          })),
        }),
      );
      const result = await f.casting.select(run, chapter, completed(['speaker-one', 'speaker-two']), signal());
      expect(result?.assignments).toEqual({ 'speaker-one': 'designer:voice_created_1', 'speaker-two': 'local:a' });
      expect(f.design).toHaveBeenCalledTimes(1);
      expect((await pool.query("select count(*)::int n from tts_voice_designs where status='ready'")).rows[0].n).toBe(
        1,
      );
      const next = await f.run({ casting: await f.options(true) });
      expect(
        (await f.casting.select(next, chapter, completed(['speaker-one', 'speaker-two']), signal()))?.assignments,
      ).toEqual(result?.assignments);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.design).toHaveBeenCalledTimes(1);
    });
  });

  it('injects casting into the real generation service and reuses analysis and book bindings in a new job', async () => {
    await withPostgresSchema(harness!, 'voice_real_service', async (pool) => {
      const f = await setup(pool);
      const s = await serviceFixture(f);
      const old = await f.engines.loadCasting(f.engine.id);
      const analysis = await f.engines.save({
        ...old,
        purpose: 'analysis',
        name: 'Attribution fixture',
        modelId: 'attribution-model',
        paid: false,
      });
      const analyzed = completed();
      analyzed.labels[0].textHash = textIntegrityHash(chapter.paragraphs[0].text);
      const contextText = '앞 회차의 인물이 말했다. “문맥만 분석해요.”';
      await pool.query('update chapters set chapter_index=2 where id=$1', [chapter.id]);
      await pool.query("insert into chapters values('context-chapter','book','문맥 회차',1)");
      const contextParagraph = {
        id: 'context-p',
        novelId: 'book',
        chapterId: 'context-chapter',
        index: 1,
        text: contextText,
      };
      await pool.query("insert into paragraph_search values('book','context-chapter','context-p',1,$1,$2)", [
        contextParagraph,
        contextText,
      ]);
      const contextResult: Extract<SpeakerEngineResult, { kind: 'complete' }> = {
        kind: 'complete',
        ledger: {},
        identities: [{ id: 'context-only-person', name: '앞 회차 인물', reviewRequired: false }],
        labels: [
          {
            paragraphId: 'context-p',
            startOffset: 0,
            endOffset: contextText.length,
            textHash: textIntegrityHash(contextText),
            speakerId: 'context-only-person',
            reviewRequired: false,
          },
        ],
      };
      const capabilities = vi.spyOn(f.transport, 'capabilities').mockResolvedValue({ engineVersion: ENGINE_VERSION });
      const step = vi
        .spyOn(f.transport, 'step')
        .mockImplementation(async (_engine, packet) =>
          packet.source.chapter.id === 'context-chapter' ? contextResult : analyzed,
        );
      const select = vi.spyOn(f.casting, 'select');
      try {
        const input: SpeakerGenerationInput = {
          chapterIds: [chapter.id],
          engineId: analysis.id,
          narratorVoiceId: 'local:n',
          characterVoiceIds: ['local:a', 'local:b'],
          rules: [],
          footnotePlayback: 'skip',
          casting: await f.options(),
        };
        const estimate = await s.service.estimate('book', input);
        expect(estimate.paid).toBe(true);
        await expect(s.service.create('book', input, estimate.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        expect(f.generate).not.toHaveBeenCalled();
        const first = await s.service.create('book', input, estimate.fingerprint, true);
        await s.audio.tick();
        await s.audio.tick();
        expect(
          (
            await pool.query('select next_chapter,assignments from speaker_generation_runs where audiobook_id=$1', [
              first.id,
            ])
          ).rows[0],
        ).toEqual({ next_chapter: 1, assignments: {} });
        expect(select).not.toHaveBeenCalled();
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.design).not.toHaveBeenCalled();
        expect((await pool.query('select count(*)::int n from saved_audiobook_items')).rows[0].n).toBe(0);
        await s.untilCompleted(first.id);
        expect(f.generate).toHaveBeenCalledTimes(1);
        expect(f.design).not.toHaveBeenCalled();
        expect(step).toHaveBeenCalledTimes(2);
        expect((await s.service.castings(first.id))[0]).toMatchObject({ speakerId: 'speaker-one', voiceId: 'local:a' });
        const saved = await f.library.save(metadata());
        await f.library.save(
          { ...metadata(), alias: '설명만 바뀐 목소리', description: '합성 모델은 그대로' },
          saved.id,
        );
        const secondInput = { ...input, characterVoiceIds: ['local:b', 'local:a'] };
        const secondEstimate = await s.service.estimate('book', secondInput);
        const second = await s.service.create('book', secondInput, secondEstimate.fingerprint, true);
        expect(second.id).not.toBe(first.id);
        f.generate.mockClear();
        step.mockClear();
        await s.untilCompleted(second.id);
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.design).not.toHaveBeenCalled();
        expect(step).not.toHaveBeenCalled();
        expect((await s.service.castings(second.id))[0].voiceId).toBe('local:a');
        const rows = (
          await pool.query('select analysis_key,assignments from speaker_generation_runs order by audiobook_id')
        ).rows;
        expect(new Set(rows.map((r) => r.analysis_key)).size).toBe(1);
        expect(rows.every((r) => r.assignments['speaker-one'] === 'local:a')).toBe(true);
        expect((await pool.query('select count(*)::int n from speaker_voice_bindings')).rows[0].n).toBe(1);
        expect(f.fetchImpl).not.toHaveBeenCalled();
      } finally {
        capabilities.mockRestore();
        step.mockRestore();
        select.mockRestore();
        await s.cleanup();
      }
    });
  });

  it('allows only a cost-confirmed explicit resume to retry this job ambiguous design operations', async () => {
    await withPostgresSchema(harness!, 'voice_confirmed_resume', async (pool) => {
      const f = await setup(pool);
      const s = await serviceFixture(f);
      const run = await f.run({ casting: await f.options(true) });
      const own = `cast_${run.id.replaceAll('-', '')}_speakerone`;
      const foreign = `cast_${randomUUID().replaceAll('-', '')}_speakerone`;
      try {
        await pool.query("update saved_audiobooks set status='failed',estimate='{\"paid\":true}'::jsonb where id=$1", [
          run.id,
        ]);
        await pool.query(
          "insert into tts_voice_designs(user_id,request_id,input_hash,status) values('owner',$1,'fixture','uncertain'),('owner',$2,'fixture','uncertain'),('other',$3,'fixture','uncertain')",
          [own, foreign, own],
        );
        await s.audio.tick();
        expect(
          (await pool.query('select status from tts_voice_designs where user_id=$1 and request_id=$2', ['owner', own]))
            .rows[0].status,
        ).toBe('uncertain');
        await expect(s.audio.control(run.id, 'resume', false)).rejects.toMatchObject({ statusCode: 400 });
        expect(
          (await pool.query('select status from tts_voice_designs where user_id=$1 and request_id=$2', ['owner', own]))
            .rows[0].status,
        ).toBe('uncertain');
        await s.audio.control(run.id, 'resume', true);
        expect(
          (await pool.query('select status from tts_voice_designs where user_id=$1 and request_id=$2', ['owner', own]))
            .rows[0].status,
        ).toBe('retry');
        expect(
          (
            await pool.query('select status from tts_voice_designs where user_id=$1 and request_id=$2', [
              'owner',
              foreign,
            ])
          ).rows[0].status,
        ).toBe('uncertain');
        expect(
          (await pool.query('select status from tts_voice_designs where user_id=$1 and request_id=$2', ['other', own]))
            .rows[0].status,
        ).toBe('uncertain');
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.design).not.toHaveBeenCalled();
      } finally {
        await s.cleanup();
      }
    });
  });

  it('keeps unknown narration out of paid selection and reuses an existing voice for an extra', async () => {
    await withPostgresSchema(harness!, 'voice_unknown_extra', async (pool) => {
      const f = await setup(pool);
      const run = await f.run({ casting: await f.options(true) });
      const unknown = completed(['unknown']);
      unknown.identities[0].reviewRequired = true;
      unknown.labels[0].reviewRequired = true;
      expect((await f.casting.select(run, chapter, unknown, signal()))?.assignments).toEqual({});
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.design).not.toHaveBeenCalled();
      const requests = castRequests(
        [
          {
            id: 'p',
            chapterId: 'chapter',
            novelId: 'book',
            index: 1,
            text: '화자 미정 문장.',
            textHash: 'fixture',
            startOffsetInChapter: 0,
            endOffsetInChapter: 9,
          },
        ],
        [],
        [],
        {},
        run.settings,
      );
      expect(requests.every((r) => r.voiceId === 'local:n')).toBe(true);
      await f.casting.select(run, chapter, completed(['extra-one']), signal());
      const next = await f.run({ casting: await f.options(true) });
      expect(
        (await f.casting.select(next, chapter, completed(['extra-one']), signal()))?.assignments['extra-one'],
      ).toBe('local:a');
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.design).not.toHaveBeenCalled();
    });
  });
});

(harness ? describe : describe.skip)('natural character voice workflow', () => {
  it('does not overwrite a newer book voice when a delayed design finishes', async () => {
    await withPostgresSchema(harness!, 'book_voice_conflict', async (pool) => {
      const f = await setup(pool, true),
        run = await f.run();
      await f.casting.select(run, chapter, completed(), signal());
      const versions = await bookBindingVersions(pool, 'owner', 'book', run.analysis_key, ['speaker-one']);
      await pool.query(
        "update speaker_voice_bindings set voice_id='local:b',pinned=true,updated_at=now() where speaker_id='speaker-one'",
      );
      const c = await pool.connect();
      try {
        await c.query('begin');
        await expect(
          applyBookVoiceUpdates(
            c,
            'owner',
            'book',
            run.analysis_key,
            [
              {
                speakerId: 'speaker-one',
                name: '민아',
                voiceId: 'designer:preset',
                model: voiceSourceModel(f.designer),
              },
            ],
            versions,
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await c.query('rollback');
        c.release();
      }
      expect(
        (await pool.query("select voice_id from speaker_voice_bindings where speaker_id='speaker-one'")).rows[0]
          .voice_id,
      ).toBe('local:b');
    });
  });

  it('replaces automatic presets, creates supporting voices within budget, then reuses designed and pinned voices', async () => {
    await withPostgresSchema(harness!, 'natural_cast', async (pool) => {
      const f = await setup(pool, true);
      const initial = await f.run({ casting: await f.options() });
      await f.casting.select(initial, chapter, completed(['one', 'two']), signal());
      f.generate.mockImplementation(async (_engine, req) =>
        JSON.stringify({
          assignments: JSON.parse(req.prompt).characters.map((c: { id: string; name: string }) => ({
            speakerId: c.id,
            voiceId: 'local:a',
            importance: 'supporting',
            alias: c.name,
            timbre: '차분함',
            description: '지속적인 음색',
            designPrompt: '차분하고 또렷한 성인 목소리. 장면별 감정은 지정하지 않는다.',
          })),
        }),
      );
      const options = { ...(await f.options(true)), designMode: 'characters' as const };
      const run = await f.run({ casting: options });
      const result = await f.casting.select(run, chapter, completed(['one', 'two']), signal());
      expect(result?.assignments).toEqual({ one: 'designer:voice_created_1', two: 'local:a' });
      expect(f.design).toHaveBeenCalledTimes(1);
      await pool.query("update speaker_voice_bindings set pinned=true where speaker_id='two'");
      f.generate.mockClear();
      const next = await f.run({ casting: options });
      expect((await f.casting.select(next, chapter, completed(['one', 'two']), signal()))?.assignments).toEqual(
        result?.assignments,
      );
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.design).toHaveBeenCalledTimes(1);
    });
  });

  it('persists each casting batch so budget fallbacks cannot loop before later characters', async () => {
    await withPostgresSchema(harness!, 'natural_batches', async (pool) => {
      const f = await setup(pool, true);
      f.generate.mockImplementation(async (_e, req) =>
        JSON.stringify({
          assignments: JSON.parse(req.prompt).characters.map((c: { id: string; name: string }) => ({
            speakerId: c.id,
            voiceId: 'local:a',
            importance: 'supporting',
            alias: c.name,
            timbre: '',
            description: '',
            designPrompt: '차분한 목소리',
          })),
        }),
      );
      const run = await f.run({ casting: { ...(await f.options(true)), designMode: 'characters' } });
      const result = completed(Array.from({ length: 9 }, (_, i) => 'person-' + i));
      expect(await f.casting.select(run, chapter, result, signal())).toBeUndefined();
      const saved = (
        await pool.query(
          'select r.assignments,a.settings from speaker_generation_runs r join saved_audiobooks a on a.id=r.audiobook_id where a.id=$1',
          [run.id],
        )
      ).rows[0];
      expect(Object.keys(saved.assignments)).toHaveLength(8);
      const finished = await f.casting.select({ ...run, ...saved }, chapter, result, signal());
      expect(Object.keys(finished!.assignments)).toHaveLength(9);
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.design).toHaveBeenCalledTimes(1);
    });
  });

  it('recasts captured spans without analysis, preserves original audio and book bindings, and keeps budget fallback voices', async () => {
    await withPostgresSchema(harness!, 'natural_revoice', async (pool) => {
      const f = await setup(pool, true),
        s = await serviceFixture(f);
      const analysis = await f.engines.save({
        ...(await f.engines.loadCasting(f.engine.id)),
        purpose: 'analysis',
        name: 'Analysis',
        modelId: 'analysis',
        paid: false,
      });
      const analyzed = completed(['one', 'two']);
      analyzed.labels.forEach((l, i) => (l.textHash = textIntegrityHash(chapter.paragraphs[i].text)));
      vi.spyOn(f.transport, 'capabilities').mockResolvedValue({ engineVersion: ENGINE_VERSION });
      const step = vi.spyOn(f.transport, 'step').mockResolvedValue(analyzed);
      try {
        const input: SpeakerGenerationInput = {
          chapterIds: [chapter.id],
          engineId: analysis.id,
          narratorVoiceId: 'designer:preset',
          characterVoiceIds: ['local:a', 'local:b'],
          rules: [],
          footnotePlayback: 'skip',
          casting: await f.options(),
        };
        await expect(
          s.service.estimate('book', {
            ...input,
            narratorVoiceId: 'local:n',
            casting: { ...(await f.options(true)), designMode: 'characters' },
          }),
        ).rejects.toMatchObject({ statusCode: 400 });
        const estimate = await s.service.estimate('book', input);
        const original = await s.service.create('book', input, estimate.fingerprint, true);
        await s.untilCompleted(original.id);
        const before = (
          await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [original.id])
        ).rows;
        const bindings = (await pool.query('select * from speaker_voice_bindings order by speaker_id')).rows;
        const analysisRows = (await pool.query('select * from speaker_analysis order by chapter_id')).rows;
        await f.engines.remove(analysis.id);
        step.mockClear();
        f.generate.mockImplementation(async (_e, req) =>
          JSON.stringify({
            assignments: JSON.parse(req.prompt).characters.map((c: { id: string; name: string }) => ({
              speakerId: c.id,
              voiceId: 'local:a',
              importance: 'supporting',
              alias: c.name,
              timbre: '낮음',
              description: '차분함',
              designPrompt: '차분하고 낮은 성인 목소리',
            })),
          }),
        );
        const choices = {
          voices: (await s.service.revoiceSource('book', original.id)).voices.map((v) => ({
            speakerId: v.speakerId,
            voiceId: v.voiceId,
          })),
          casting: { ...(await f.options(true)), designMode: 'characters' as const },
        };
        const unsupported = { ...choices.casting, designModelId: 'gemini-3.8-flash-lite-tts' };
        await expect(
          s.service.estimateRevoice('book', original.id, { ...choices, casting: unsupported }),
        ).rejects.toMatchObject({ statusCode: 400 });
        const price = await s.service.estimateRevoice('book', original.id, choices);
        expect(price).toMatchObject({ paid: true, recastCharacters: 2, maxDesignedVoices: 1 });
        expect(f.design).not.toHaveBeenCalled();
        await expect(s.service.revoice('book', original.id, choices, price.fingerprint, false)).rejects.toMatchObject({
          statusCode: 400,
        });
        const variant = await s.service.revoice('book', original.id, choices, price.fingerprint, true);
        const same = await s.service.revoice('book', original.id, choices, price.fingerprint, true);
        expect(same.id).toBe(variant.id);
        const rendersBefore = s.render.mock.calls.length;
        f.design.mockImplementationOnce(async () => {
          await s.audio.control(variant.id, 'pause');
          return { id: 'voice_created_1', sample: { data: sample, contentType: 'audio/wav' } };
        });
        f.generate.mockClear();
        await s.audio.tick();
        expect((await s.audio.get(variant.id)).status).toBe('paused');
        expect(s.render).toHaveBeenCalledTimes(rendersBefore);
        expect(f.design).toHaveBeenCalledTimes(1);
        expect(f.generate).toHaveBeenCalledTimes(1);
        await s.audio.control(variant.id, 'resume', true);
        await s.untilCompleted(variant.id);
        expect(f.generate).toHaveBeenCalledTimes(1);
        expect(f.design).toHaveBeenCalledTimes(1);
        expect(step).not.toHaveBeenCalled();
        const updated = (
          await pool.query('select request from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
            variant.id,
          ])
        ).rows;
        expect(
          updated
            .filter((r) => r.request.cast.speakerId === 'one')
            .every((r) => r.request.voiceId === 'designer:voice_created_1'),
        ).toBe(true);
        expect(
          updated.filter((r) => r.request.cast.speakerId === 'two').every((r) => r.request.voiceId === 'local:a'),
        ).toBe(true);
        expect(updated.map((r) => ({ ...r.request.cast, model: undefined }))).toEqual(
          before.map((r) => ({ ...r.request.cast, model: undefined })),
        );
        expect(
          (
            await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
              original.id,
            ])
          ).rows,
        ).toEqual(before);
        expect((await pool.query('select * from speaker_voice_bindings order by speaker_id')).rows).toEqual(bindings);
        expect((await pool.query('select * from speaker_analysis order by chapter_id')).rows).toEqual(analysisRows);
        await pool.query("update speaker_voice_bindings set pinned=true where speaker_id='one'");
        const pinned = await s.service.estimateRevoice('book', original.id, choices);
        expect(pinned.recastCharacters).toBe(1);
        const manual = {
          ...choices,
          voices: choices.voices.map((v) => (v.speakerId === 'two' ? { ...v, voiceId: 'local:b' } : v)),
        };
        await expect(s.service.estimateRevoice('book', original.id, manual)).rejects.toThrow('인물이 없어요');
        const sourceView = await s.service.revoiceSource('book', original.id);
        expect(sourceView.narratorVoiceId).toBe('designer:preset');
        expect(sourceView.voices.find((v) => v.speakerId === 'one')).toMatchObject({ pinned: true, designed: false });
        const explicit = {
          ...manual,
          designSpeakerIds: ['one'],
          applyToBook: true,
          casting: { ...choices.casting, maxDesignedVoices: 0 },
        };
        for (const ids of [[], ['one', 'one'], ['missing'], ['narrator'], Array(9).fill('one')])
          await expect(
            s.service.estimateRevoice('book', original.id, { ...explicit, designSpeakerIds: ids }),
          ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          s.service.estimateRevoice('book', original.id, { ...explicit, casting: undefined }),
        ).rejects.toMatchObject({ statusCode: 400 });
        f.generate.mockImplementation(async (_e, req) => {
          const data = JSON.parse(req.prompt);
          expect(data.requiredDesignSpeakerIds).toEqual(['one']);
          return JSON.stringify({
            assignments: data.characters.map((c: { id: string; name: string }) => ({
              speakerId: c.id,
              voiceId: data.candidates[0].voiceId,
              importance: 'extra',
              alias: c.name,
              timbre: '또렷함',
              description: '본문에 근거한 성인 여성',
              designPrompt: '또렷하고 차분한 성인 여성 목소리',
            })),
          });
        });
        const currentCatalog = await f.catalog();
        const withoutOldVoice = { ...currentCatalog, voices: currentCatalog.voices.filter((v) => v.id !== 'local:a') };
        const replacementPlan = await planSpeakerRevoice(
          pool,
          'owner',
          'book',
          original.id,
          {
            ...explicit,
            voices: explicit.voices.map((v) =>
              v.speakerId === 'one' ? { ...v, voiceId: 'deleted-voice', instructions: '조용하게' } : v,
            ),
          },
          withoutOldVoice,
          f.engines,
          f.library,
        );
        expect(replacementPlan.estimate.recastCharacters).toBe(1);
        expect(
          replacementPlan.items.find((i) => (i.request as CastRequest).cast.speakerId === 'one')?.request,
        ).toMatchObject({ voiceId: 'designer:preset', cast: { instructions: '조용하게' } });
        expect(replacementPlan.planningComplete).toBe(false);
        const explicitPrice = await s.service.estimateRevoice('book', original.id, explicit);
        expect(explicitPrice).toMatchObject({ recastCharacters: 1, maxDesignedVoices: 1 });
        const changed = await s.service.revoice('book', original.id, explicit, explicitPrice.fingerprint, true);
        expect((await s.service.revoice('book', original.id, explicit, explicitPrice.fingerprint, true)).id).toBe(
          changed.id,
        );
        expect(
          (await pool.query("select voice_id,pinned from speaker_voice_bindings where speaker_id='two'")).rows[0],
        ).toEqual({ voice_id: 'local:b', pinned: true });
        f.design.mockResolvedValueOnce({ id: 'voice_created_2', sample: { data: sample, contentType: 'audio/wav' } });
        await s.untilCompleted(changed.id);
        const newlyAssigned = (
          await pool.query("select voice_id,pinned from speaker_voice_bindings where speaker_id='one'")
        ).rows[0];
        expect(newlyAssigned.pinned).toBe(true);
        expect(newlyAssigned.voice_id).toMatch(/^designer:voice_created_/);
        expect(newlyAssigned.voice_id).not.toBe('designer:voice_created_1');
        const changedSource = await s.service.revoiceSource('book', changed.id);
        expect(changedSource.voices.find((v) => v.speakerId === 'one')).toMatchObject({ pinned: true, designed: true });
        expect(
          (
            await pool.query('select * from saved_audiobook_items where audiobook_id=$1 order by ordinal', [
              original.id,
            ])
          ).rows,
        ).toEqual(before);
        expect((await pool.query('select * from speaker_analysis order by chapter_id')).rows).toEqual(analysisRows);
        // A failed explicit design cannot silently synthesize with an old/pool voice or change book defaults.
        const failInput = {
          ...explicit,
          voices: changedSource.voices.map((v) => ({ speakerId: v.speakerId, voiceId: v.voiceId })),
        };
        const failPrice = await s.service.estimateRevoice('book', changed.id, failInput);
        const failed = await s.service.revoice('book', changed.id, failInput, failPrice.fingerprint, true);
        const renderCount = s.render.mock.calls.length;
        f.design.mockRejectedValueOnce(new Error('fixture design unavailable'));
        await s.audio.tick();
        expect((await s.audio.get(failed.id)).status).toBe('failed');
        expect(s.render).toHaveBeenCalledTimes(renderCount);
        expect(
          (await pool.query("select voice_id,pinned from speaker_voice_bindings where speaker_id='one'")).rows[0],
        ).toEqual(newlyAssigned);
        await pool.query("update library_books set active_content_revision_id='changed' where id='book'");
        await expect(s.service.revoice('book', original.id, choices, pinned.fingerprint, true)).rejects.toMatchObject({
          statusCode: 409,
        });
      } finally {
        await s.cleanup();
      }
    });
  });
});
