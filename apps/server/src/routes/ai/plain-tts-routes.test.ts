import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Paragraph } from '../../../../../src/domain/types';
import type { TTSSynthesisProvider } from '../../../../../src/providers/tts';
import {
  buildPlainTTSBatch,
  buildPlainTTSItems,
  plainTTSParagraphHash,
  PLAIN_TTS_SAMPLE,
} from '../../../../../src/providers/plain-tts';
import { loadConfig } from '../../config.js';
import type { PlainTTSSource } from '../../providers/plain-tts-sources.js';
import { classifyPlainTTSFailure, registerPlainTTSRoutes } from './plain-tts-routes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(envPatch: NodeJS.ProcessEnv = {}, sources?: () => Promise<PlainTTSSource[]>) {
  const paragraph: Paragraph = {
    id: 'paragraph_plain',
    novelId: 'book_plain',
    chapterId: 'chapter_plain',
    index: 0,
    text: '서버에서 본문을 읽습니다.',
    textHash: 'unused',
    startOffsetInChapter: 0,
    endOffsetInChapter: 16,
  };
  const source = {
    paragraph,
    text: paragraph.text,
    book_id: paragraph.novelId,
    language: 'ko',
    active_content_revision_id: 'content_1' as string | null,
    paragraph_index: 0,
  };
  const sourceRows = [source];
  let owner = 'user_plain';
  let deleted = false;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // A fake database containing only source text: graph/segment/job dependencies fail the request.
    expect(sql).toContain('from paragraph_search p join library_books b');
    expect(sql).toContain('b.user_id = $3');
    expect(sql).toContain('b.deleted_at is null');
    expect(sql).not.toMatch(/labeled_segments|character_graph|provider_jobs|voice_profiles/);
    return {
      rows:
        params?.[0] === paragraph.chapterId && params?.[2] === owner && !deleted
          ? sourceRows.filter((row) => row.paragraph.id === params?.[1]).map((row) => ({ ...row }))
          : [],
    };
  });
  const audio = { audio: new Uint8Array([82, 73, 70, 70, 1, 2]).buffer as ArrayBuffer, contentType: 'audio/wav' };
  const synthesize = vi.fn<TTSSynthesisProvider['synthesize']>().mockResolvedValue(audio);
  const listVoices = vi.fn(async () => [{ id: 'M1', label: '기본', lang: 'ko' }]);
  const provider: TTSSynthesisProvider = {
    providerId: 'local-endpoint',
    displayName: 'Test local only',
    supportsStreaming: false,
    supportsAudioCache: true,
    supportsPerCharacterVoice: true,
    listVoices,
    synthesize,
  };
  const app = Fastify();
  apps.push(app);
  await registerPlainTTSRoutes(app, { query } as unknown as pg.Pool, loadConfig({ DEFAULT_USER_ID: 'user_plain' }), {
    provider,
    sources,
    env: {
      TTS_PLAIN_ENABLED: 'true',
      TTS_PLAIN_MODEL_ID: 'supertonic3',
      TTS_PLAIN_MODEL_REVISION: 'model_1',
      ...envPatch,
    },
  });
  const item = buildPlainTTSItems({ paragraph, language: 'ko', rate: 1 })[0];
  const body = {
    voiceId: 'M1',
    rate: 1,
    modelRevision: 'model_1',
    paragraphId: paragraph.id,
    paragraphHash: plainTTSParagraphHash(paragraph),
    contentRevision: 'content_1',
    chunkHash: item.spokenTextFingerprint,
    rules: [],
  };
  const request = (patch: Record<string, unknown> = {}, chapterId = paragraph.chapterId) =>
    app.inject({ method: 'POST', url: `/api/chapters/${chapterId}/tts/plain`, payload: { ...body, ...patch } });
  return {
    app,
    source,
    sourceRows,
    query,
    provider,
    synthesize,
    listVoices,
    audio,
    body,
    request,
    setOwner: (value: string) => {
      owner = value;
    },
    setDeleted: () => {
      deleted = true;
    },
  };
}

describe('plain paragraph TTS routes', () => {
  it('discovers the configured local model and synthesizes from owned source without analysis data', async () => {
    const f = await fixture();
    const catalog = await f.app.inject('/api/tts/plain/voices');
    expect(catalog.json()).toMatchObject({
      available: true,
      modelId: 'supertonic3',
      revision: 'model_1',
      voices: [{ id: 'M1' }],
    });
    const response = await f.request();
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.rawPayload).toEqual(Buffer.from(f.audio.audio));
    expect(f.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: f.source.text,
        speed: 1,
        format: 'wav',
        voiceProfile: expect.objectContaining({
          providerId: 'local-endpoint',
          providerVoiceId: 'M1',
          role: 'narrator',
        }),
      }),
    );
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it.each(['other-owner', 'deleted', 'other-chapter', 'other-paragraph'])(
    'rejects unavailable ownership/source: %s',
    async (kind) => {
      const f = await fixture();
      if (kind === 'other-owner') f.setOwner('someone_else');
      if (kind === 'deleted') f.setDeleted();
      const response = await f.request(
        kind === 'other-paragraph' ? { paragraphId: 'other_paragraph' } : {},
        kind === 'other-chapter' ? 'other_chapter' : undefined,
      );
      expect(response.statusCode).toBe(404);
      expect(f.synthesize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['content revision', { contentRevision: 'stale_content' }, 409],
    ['paragraph hash', { paragraphHash: 'stale_hash' }, 409],
    ['chunk hash', { chunkHash: 'invented_chunk' }, 409],
    ['model revision', { modelRevision: 'stale_model' }, 409],
    ['unknown voice', { voiceId: 'unknown' }, 400],
    ['invalid rate', { rate: 0 }, 400],
    ['malformed rules', { rules: [{ kind: 'regex' }] }, 400],
  ] as const)('rejects %s before synthesis', async (_name, patch, status) => {
    const f = await fixture();
    expect((await f.request(patch)).statusCode).toBe(status);
    expect(f.synthesize).not.toHaveBeenCalled();
  });

  it('coalesces concurrent identical synthesis and serves subsequent cache hits after source checks', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<typeof f.audio>();
    f.synthesize.mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const first = f.request().then((response) => response);
    await entered.promise;
    const second = f.request().then((response) => response);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    release.resolve(f.audio);
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect((await f.request()).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledTimes(6);
    f.setOwner('revoked');
    expect((await f.request()).statusCode).toBe(404);
  });

  it.each(['text', 'revision', 'owner'])('does not return audio when %s changes during synthesis', async (change) => {
    const f = await fixture();
    f.synthesize.mockImplementation(async () => {
      if (change === 'text') f.source.text = '합성 중 변경된 본문입니다.';
      if (change === 'revision') f.source.active_content_revision_id = 'content_2';
      if (change === 'owner') f.setOwner('another_user');
      return f.audio;
    });
    const response = await f.request();
    expect(response.statusCode).toBe(change === 'owner' ? 404 : 409);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('uses a fixed sample without any database queries', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/tts/plain/sample',
      payload: { voiceId: 'M1', modelRevision: 'model_1', rate: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: PLAIN_TTS_SAMPLE }));
    expect(f.query).not.toHaveBeenCalled();
  });

  it('reports a disabled local model without using the provider', async () => {
    const f = await fixture({ TTS_PLAIN_ENABLED: 'false' });
    expect((await f.app.inject('/api/tts/plain/voices')).json()).toMatchObject({ available: false, voices: [] });
    expect((await f.request()).statusCode).toBe(503);
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.listVoices).not.toHaveBeenCalled();
  });
});

describe('ordinary narration across providers', () => {
  it('reads owned source through a paid API without any cast data or local model', async () => {
    const remote = vi
      .fn<TTSSynthesisProvider['synthesize']>()
      .mockResolvedValue({ audio: new Uint8Array([1, 2]).buffer, contentType: 'audio/wav' });
    let enabled = true;
    const f = await fixture({ TTS_PLAIN_ENABLED: 'false' }, async () =>
      enabled
        ? [
            {
              id: 'gemini-tts',
              name: 'Gemini',
              modelId: 'gemini-3.8-flash-lite-tts',
              revision: 'remote-v1',
              paid: true,
              providerOptions: { voice: 'old', instructions: 'Calm' },
              createProvider: async () => ({ ...f.provider, providerId: 'gemini-tts', synthesize: remote }),
            },
          ]
        : [],
    );
    const catalog = (await f.app.inject('/api/tts/plain/voices')).json();
    expect(catalog).toMatchObject({
      available: true,
      defaultVoiceId: 'gemini-tts:old',
      voices: [{ id: 'gemini-tts:M1', paid: true }, { id: 'gemini-tts:old' }],
    });
    const request = { voiceId: 'gemini-tts:M1', modelRevision: catalog.revision };
    expect((await f.request(request)).statusCode).toBe(200);
    expect(remote).toHaveBeenCalledWith(
      expect.objectContaining({
        text: f.source.text,
        providerOptions: { voice: 'M1', instructions: 'Calm' },
        voiceProfile: expect.objectContaining({ role: 'narrator', providerId: 'gemini-tts', providerVoiceId: 'M1' }),
      }),
    );
    expect(f.synthesize).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(2);
    enabled = false;
    expect((await f.request(request)).statusCode).toBe(503);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('keeps the default unavailable instead of falling back to a paid engine', async () => {
    const remote = vi
      .fn<TTSSynthesisProvider['synthesize']>()
      .mockResolvedValue({ audio: new Uint8Array([9]).buffer, contentType: 'audio/wav' });
    const f = await fixture({}, async () => [
      {
        id: 'gemini-tts',
        name: 'Gemini',
        revision: 'v1',
        paid: true,
        createProvider: async () => ({
          ...f.provider,
          providerId: 'gemini-tts',
          listVoices: async () => [{ id: 'M1', label: 'remote M1', lang: 'ko' }],
          synthesize: remote,
        }),
      },
    ]);
    f.listVoices.mockRejectedValue(new Error('offline'));
    const catalog = (await f.app.inject('/api/tts/plain/voices')).json();
    expect(catalog).toMatchObject({
      available: true,
      defaultVoiceId: '',
      providers: [
        { id: 'supertonic', available: false },
        { id: 'gemini-tts', available: true },
      ],
    });
    expect((await f.request({ modelRevision: catalog.revision })).statusCode).toBe(502);
    expect(remote).not.toHaveBeenCalled();
    expect((await f.request({ voiceId: 'gemini-tts:M1', modelRevision: catalog.revision })).statusCode).toBe(200);
  });

  it('separates cache entries for the same voice name on different engines', async () => {
    const remote = vi
      .fn<TTSSynthesisProvider['synthesize']>()
      .mockResolvedValue({ audio: new Uint8Array([9]).buffer, contentType: 'audio/wav' });
    const f = await fixture({}, async () => [
      {
        id: 'openai-tts',
        name: 'OpenAI',
        revision: 'v1',
        paid: true,
        createProvider: async () => ({ ...f.provider, providerId: 'openai-tts', synthesize: remote }),
      },
    ]);
    const catalog = (await f.app.inject('/api/tts/plain/voices')).json();
    const local = await f.request({ modelRevision: catalog.revision });
    const external = await f.request({ voiceId: 'openai-tts:M1', modelRevision: catalog.revision });
    expect(local.statusCode).toBe(200);
    expect(external.statusCode).toBe(200);
    expect(local.rawPayload).not.toEqual(external.rawPayload);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
  });
});

describe('plain TTS failure classification', () => {
  it('distinguishes upstream capacity, permissions, timeout, and empty audio without exposing details', () => {
    expect(classifyPlainTTSFailure({ status: 429, message: 'private key and text' }).code).toBe('tts_rate_limited');
    expect(classifyPlainTTSFailure({ status: 403 }).code).toBe('tts_access_denied');
    expect(classifyPlainTTSFailure({ name: 'TimeoutError' }).code).toBe('tts_timeout');
    expect(classifyPlainTTSFailure(new Error('Gemini Vertex TTS returned no audio data')).code).toBe('tts_no_audio');
    expect(JSON.stringify(classifyPlainTTSFailure(new Error('secret document')))).not.toContain('secret document');
  });
  it('surfaces rate limits instead of a generic playback failure', async () => {
    const f = await fixture();
    f.synthesize.mockRejectedValue(Object.assign(new Error('private provider body'), { status: 429 }));
    const response = await f.request();
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('tts_rate_limited');
    expect(response.body).not.toContain('private provider body');
  });
  it('verifies paragraph chunks on the server and rejects unsupported units', async () => {
    const f = await fixture();
    f.source.text = f.source.paragraph.text = '첫 문장입니다. 다음 문장입니다.';
    const [item] = buildPlainTTSItems({ paragraph: f.source.paragraph, rate: 1, chunking: 'paragraph' });
    const body = {
      paragraphHash: plainTTSParagraphHash(f.source.paragraph),
      chunkHash: item.spokenTextFingerprint,
      chunking: 'paragraph',
    };
    expect((await f.request(body)).statusCode).toBe(200);
    expect(f.synthesize.mock.calls[0][0].text).toBe(f.source.text);
    expect((await f.request({ ...body, chunking: 'sentence' })).statusCode).toBe(409);
    expect((await f.request({ ...body, chunking: 'unbounded' })).statusCode).toBe(400);
  });
});

describe('batch source verification and quota cooldown', () => {
  it('reconstructs the configured batch size and rejects out-of-range limits before synthesis', async () => {
    const f = await fixture();
    f.source.text = f.source.paragraph.text = '가'.repeat(800);
    const [item] = buildPlainTTSItems({
      paragraph: f.source.paragraph,
      rate: 1,
      chunking: 'batch',
      batchCharacters: 1200,
    });
    const body = {
      chunking: 'batch',
      batchCharacters: 1200,
      paragraphHash: plainTTSParagraphHash(f.source.paragraph),
      chunkHash: item.spokenTextFingerprint,
    };
    expect((await f.request(body)).statusCode).toBe(200);
    expect(f.synthesize.mock.calls[0][0].text).toBe(f.source.text);
    expect((await f.request({ ...body, batchCharacters: 700 })).statusCode).toBe(409);
    for (const batchCharacters of [0, 199, 2001, Infinity, '700', 350.5])
      expect((await f.request({ ...body, batchCharacters })).statusCode).toBe(400);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });
  it('does not cache or accept incomplete audio as a successful synthesis', async () => {
    const f = await fixture();
    f.synthesize.mockRejectedValueOnce(
      Object.assign(new Error('private upstream detail'), { code: 'tts_incomplete_audio' }),
    );
    const response = await f.request();
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('tts_incomplete_audio');
    expect(response.body).not.toContain('private upstream detail');
    expect((await f.request()).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(2);
  });
  it('synthesizes one batch, rejects stale secondary source and checks ownership on cache hits', async () => {
    const f = await fixture();
    const next = {
      ...f.source,
      paragraph_index: 1,
      text: '두번째 문단입니다.',
      paragraph: { ...f.source.paragraph, id: 'paragraph_second', index: 1, text: '두번째 문단입니다.' },
    };
    f.sourceRows.push(next);
    const item = buildPlainTTSBatch({ paragraphs: f.sourceRows.map((row) => row.paragraph), rate: 1 })!;
    const body = { chunking: 'batch', batch: item.plainBatch, chunkHash: item.spokenTextFingerprint };
    expect((await f.request(body)).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    expect(f.synthesize.mock.calls[0][0].text).toBe(f.source.text + '\n\n' + next.text);
    expect((await f.request(body)).statusCode).toBe(200);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
    next.text += ' 변경';
    expect((await f.request(body)).statusCode).toBe(409);
    f.setOwner('another_owner');
    expect((await f.request(body)).statusCode).toBe(404);
  });
  it('blocks reversed or foreign paragraph batches before paying for synthesis', async () => {
    const f = await fixture();
    const next = { ...f.source, paragraph_index: -1, paragraph: { ...f.source.paragraph, id: 'p2', index: 1 } };
    f.sourceRows.push(next);
    const item = buildPlainTTSBatch({ paragraphs: f.sourceRows.map((row) => row.paragraph), rate: 1 })!;
    const body = { chunking: 'batch', batch: item.plainBatch, chunkHash: item.spokenTextFingerprint };
    expect((await f.request(body)).statusCode).toBe(400);
    next.paragraph_index = 1;
    next.book_id = 'foreign';
    expect((await f.request(body)).statusCode).toBe(400);
    expect(f.synthesize).not.toHaveBeenCalled();
  });
  it('shares the cooldown across distinct requests without hitting the upstream again', async () => {
    const f = await fixture();
    f.synthesize.mockRejectedValue({ status: 429 });
    const first = await f.request();
    expect(first.statusCode).toBe(429);
    expect(first.json().retryAfterSeconds).toBe(10);
    const second = await f.request({ rate: 1.1 });
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(f.synthesize).toHaveBeenCalledTimes(1);
  });
});

it('verifies regex-filtered speech against source and refuses unsupported regex before synthesis', async () => {
  const f = await fixture();
  const rules = [
    {
      id: 'filter',
      scope: 'book' as const,
      kind: 'replace_regex' as const,
      pattern: '(서버)에서',
      replacement: '$1로',
      enabled: true,
      priority: 0,
      updatedAt: '',
    },
  ];
  const item = buildPlainTTSItems({ paragraph: f.source.paragraph, language: 'ko', rate: 1, rules })[0];
  const response = await f.request({ rules, chunkHash: item.spokenTextFingerprint });
  expect(response.statusCode).toBe(200);
  expect(JSON.stringify(f.synthesize.mock.calls[0])).toContain('서버로');
  const invalid = await f.request({ rules: [{ ...rules[0], pattern: '(?=x)' }] });
  expect(invalid.statusCode).toBe(400);
  expect(f.synthesize).toHaveBeenCalledTimes(1);
});
