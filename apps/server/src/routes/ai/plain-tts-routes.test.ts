import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Paragraph } from '../../../../../src/domain/types';
import type { TTSSynthesisProvider } from '../../../../../src/providers/tts';
import { buildPlainTTSItems, plainTTSParagraphHash, PLAIN_TTS_SAMPLE } from '../../../../../src/providers/plain-tts';
import { loadConfig } from '../../config.js';
import { registerPlainTTSRoutes } from './plain-tts-routes.js';

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

async function fixture(envPatch: NodeJS.ProcessEnv = {}) {
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
  };
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
        params?.[0] === paragraph.chapterId && params?.[1] === paragraph.id && params?.[2] === owner && !deleted
          ? [{ ...source }]
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
