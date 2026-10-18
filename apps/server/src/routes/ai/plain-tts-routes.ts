import { validateSpokenTextFilter } from '@boaa/text-core/spoken-text-filter';
import path from 'node:path';
import { createPlainTTSAudioCache } from '../../providers/plain-tts-audio-cache.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Paragraph, SpokenTextRule, VoiceProfile } from '@boaa/contracts';
import {
  buildPlainTTSBatch,
  buildPlainTTSItems,
  plainTTSParagraphHash,
  PLAIN_TTS_SAMPLE,
} from '../../../../../src/providers/plain-tts';
import type { TTSSynthesisProvider } from '../../../../../src/providers/tts';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { PlainTTSVoices } from '../../../../../src/providers/plain-tts';
import { loadPlainTTSSources, type PlainTTSSource } from '../../providers/plain-tts-sources.js';
import type { ServerConfig } from '../../config.js';
import { createServerTTSSynthesisProvider } from '../../providers/server-tts-provider-factory.js';

type SourceRow = {
  paragraph: Paragraph;
  text: string;
  book_id: string;
  language: string;
  active_content_revision_id: string | null;
  paragraph_index: number;
};
type Audio = { data: Buffer; contentType: string };

/** Bounded, source-verified narration. Provider selection never requires analysis or casting. */
export async function registerPlainTTSRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  options: { env?: NodeJS.ProcessEnv; provider?: TTSSynthesisProvider; sources?: () => Promise<PlainTTSSource[]> } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const modelId = env.TTS_PLAIN_MODEL_ID?.trim();
  const revision = env.TTS_PLAIN_MODEL_REVISION?.trim();
  const enabled = env.TTS_PLAIN_ENABLED === 'true' && Boolean(modelId && revision);
  const provider = enabled
    ? (options.provider ??
      createServerTTSSynthesisProvider({
        providerId: 'local-endpoint',
        env: {
          ...env,
          TTS_LOCAL_ENDPOINT_URL: env.TTS_PLAIN_ENDPOINT_URL,
          TTS_LOCAL_ENDPOINT_MODEL_ID: modelId,
          LOCAL_TTS_ALLOWED_HOSTS: env.TTS_PLAIN_ALLOWED_HOSTS ?? '',
        },
      }))
    : undefined;
  const localSource: PlainTTSSource | undefined = provider
    ? {
        id: 'supertonic',
        name: 'Supertonic 3',
        modelId,
        revision: revision!,
        paid: false,
        legacyIds: true,
        createProvider: async () => provider,
      }
    : undefined;
  const sources = async () => [
    ...(localSource ? [localSource] : []),
    ...(options.sources
      ? await options.sources()
      : options.provider
        ? []
        : await loadPlainTTSSources(pool, config, env)),
  ];
  const catalogs = new Map<string, { expires: number; task: Promise<Awaited<ReturnType<typeof discover>>> }>();
  async function discover(source: PlainTTSSource) {
    const adapter = await source.createProvider();
    if (!adapter.listVoices) throw new Error('voice_discovery_unavailable');
    const discovered = await adapter.listVoices();
    const configured = source.providerOptions?.voice;
    if (typeof configured === 'string' && configured.trim() && !discovered.some((v) => v.id === configured.trim())) {
      discovered.push({ id: configured.trim(), label: configured.trim(), lang: 'und' });
    }
    return discovered;
  }
  async function voices(source: PlainTTSSource) {
    const key = source.id + ':' + source.revision;
    const old = catalogs.get(key);
    if (old && old.expires > Date.now()) return old.task;
    const task = discover(source).catch((error) => {
      catalogs.delete(key);
      throw error;
    });
    if (catalogs.size >= 16) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, { expires: Date.now() + 30_000, task });
    return task;
  }
  const voiceKey = (source: PlainTTSSource, id: string) =>
    source.legacyIds ? id : `${source.id}:${encodeURIComponent(id)}`;
  const catalogRevision = (items: PlainTTSSource[]) =>
    items.length === 1 && items[0].legacyIds
      ? items[0].revision
      : structuredIntegrityHash(items.map(({ id, revision }) => ({ id, revision })));
  // Restarting the API drops this cache. Model weights remain in the model service's persistent volume.
  const diskCache = options.provider
    ? undefined
    : createPlainTTSAudioCache(path.join(config.dataDir, 'plain-tts-audio'));
  const cache = new Map<string, Audio>();
  let cacheBytes = 0;
  const pending = new Map<string, Promise<Audio>>();
  const maxBytes = 64 * 1024 * 1024;
  const cooldowns = new Map<string, { until: number; failures: number }>();
  async function synthesize(
    key: string,
    text: string,
    voiceId: string,
    rate: number,
    source: PlainTTSSource,
  ): Promise<Audio> {
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const current = pending.get(key);
    if (current) return current;
    if (pending.size >= 4)
      throw new PlainTTSError(429, '서버 음성이 다른 문장을 준비 중입니다. 잠시 후 다시 재생하세요.');
    const task = (async () => {
      const persisted = await diskCache?.get(key);
      if (persisted) return persisted;
      const now = new Date().toISOString();
      const adapter = await source.createProvider();
      const profile: VoiceProfile = {
        id: 'plain-default',
        novelId: '',
        role: 'narrator',
        providerId: adapter.providerId,
        providerVoiceId: voiceId,
        label: voiceId,
        language: 'ko-KR',
        speed: 1,
        pitch: 1,
        emotionPolicy: 'neutral',
        isUserSelected: true,
        createdAt: now,
        updatedAt: now,
      };
      // Ordinary listening owns voice/rate/container; cast render options must not override its controls.
      const providerOptions = { ...source.providerOptions };
      for (const option of ['responseFormat', 'outputFormat', 'audioEncoding', 'format', 'speed', 'speakingRate'])
        delete providerOptions[option];
      const cooldown = cooldowns.get(source.id);
      if (cooldown && cooldown.until > Date.now())
        throw new PlainTTSError(
          429,
          '음성 제공자의 요청 제한이 풀리기를 기다리고 있습니다.',
          Math.ceil((cooldown.until - Date.now()) / 1000),
        );
      let result;
      try {
        result = await adapter.synthesize({
          text,
          voiceProfile: profile,
          speed: rate,
          format: 'wav',
          providerOptions: { ...providerOptions, voice: voiceId },
          signal: AbortSignal.timeout(45_000),
        });
        if ((cooldowns.get(source.id)?.until ?? 0) <= Date.now()) cooldowns.delete(source.id);
      } catch (error) {
        if (classifyPlainTTSFailure(error).status === 429) {
          const failures = Math.min(3, (cooldowns.get(source.id)?.failures ?? 0) + 1);
          const seconds = 10 * 2 ** (failures - 1);
          cooldowns.set(source.id, { failures, until: Date.now() + seconds * 1000 });
          app.log.warn({ event: 'plain_tts_failed', errorCategory: 'tts_rate_limited', upstreamStatus: 429 });
          throw new PlainTTSError(
            429,
            '음성 제공자의 요청 한도 또는 처리 용량에 도달했습니다. 잠시 기다린 뒤 다시 시도합니다.',
            seconds,
          );
        }
        throw error;
      }
      const audio = { data: Buffer.from(result.audio), contentType: result.contentType };
      if (!audio.contentType.startsWith('audio/') || !audio.data.length || audio.data.length > 16 * 1024 * 1024)
        throw new PlainTTSError(502, '서버 음성의 오디오 응답이 올바르지 않습니다.');
      while (cacheBytes + audio.data.length > maxBytes && cache.size) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.data.length;
        cache.delete(oldest);
      }
      await diskCache?.put(key, audio);
      cache.set(key, audio);
      cacheBytes += audio.data.length;
      return audio;
    })().finally(() => {
      pending.delete(key);
    });
    pending.set(key, task);
    return task;
  }

  app.get('/api/tts/plain/voices', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const items = await sources();
    const results = await Promise.all(
      items.map(async (source) => {
        try {
          const found = await voices(source);
          return { source, found, available: found.length > 0 };
        } catch {
          return { source, found: [], available: false };
        }
      }),
    );
    const first = results[0];
    const defaultVoice =
      first?.found.find((voice) => voice.id === first.source.providerOptions?.voice) ?? first?.found[0];
    const result: PlainTTSVoices = {
      defaultVoiceId: defaultVoice ? voiceKey(first.source, defaultVoice.id) : '',
      available: results.some((item) => item.available),
      modelId,
      revision: catalogRevision(items),
      voices: results.flatMap(({ source, found }) =>
        found.map((voice) => ({
          ...voice,
          id: voiceKey(source, voice.id),
          providerId: source.id,
          providerName: source.name,
          modelId: source.modelId,
          paid: source.paid,
        })),
      ),
      providers: results.map(({ source, available }) => ({
        id: source.id,
        name: source.name,
        modelId: source.modelId,
        paid: source.paid,
        available,
        ...(!available ? { message: '음성 목록에 연결하지 못했습니다. 연결 설정을 확인하고 다시 불러오세요.' } : {}),
      })),
    };
    if (!items.length)
      result.message = '서버 음성을 연결하지 않았습니다. 기기 목소리를 사용하거나 TTS 엔진을 연결하세요.';
    return result;
  });

  for (const sample of [false, true]) {
    app.post<{ Params: { chapterId: string }; Body: Record<string, unknown> }>(
      sample ? '/api/tts/plain/sample' : '/api/chapters/:chapterId/tts/plain',
      { bodyLimit: 64 * 1024 },
      async (request, reply) => {
        try {
          const availableSources = await sources();
          if (!availableSources.length) throw new PlainTTSError(503, '연결된 서버 음성이 없습니다.');
          const body = request.body;
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new PlainTTSError(400, '낭독 요청이 올바르지 않습니다.');
          const { voiceId, rate, modelRevision } = body;
          if (
            typeof voiceId !== 'string' ||
            voiceId.length > 512 ||
            typeof rate !== 'number' ||
            !Number.isFinite(rate) ||
            rate < 0.5 ||
            rate > 2.5
          )
            throw new PlainTTSError(400, '목소리 또는 속도가 올바르지 않습니다.');
          if (modelRevision !== catalogRevision(availableSources))
            throw new PlainTTSError(409, '서버 모델이 변경되었습니다. 목소리 목록을 새로고침하세요.');
          const source = availableSources.find((item) =>
            item.legacyIds ? !voiceId.includes(':') : voiceId.startsWith(item.id + ':'),
          );
          if (!source) throw new PlainTTSError(400, '선택한 엔진을 찾을 수 없습니다. 목소리 목록을 새로고침하세요.');
          const selectedVoice = (await voices(source)).find((voice) => voiceKey(source, voice.id) === voiceId);
          if (!selectedVoice) throw new PlainTTSError(400, '선택한 목소리를 찾을 수 없습니다.');
          let text = PLAIN_TTS_SAMPLE;
          let sourceKey: unknown = { sample: 1 };
          const loadSource = async (
            reference = { paragraphId: body.paragraphId, paragraphHash: body.paragraphHash },
          ) => {
            const result = await pool.query<SourceRow>(
              `
              select p.paragraph, p.text, p.book_id, b.language, b.active_content_revision_id, p.paragraph_index
              from paragraph_search p join library_books b on b.id = p.book_id
              where p.chapter_id = $1 and p.paragraph_id = $2 and b.user_id = $3 and b.deleted_at is null
            `,
              [request.params.chapterId, reference.paragraphId, config.defaultUserId],
            );
            const row = result.rows[0];
            if (!row) throw new PlainTTSError(404, '원문 문단을 찾을 수 없습니다.');
            const paragraph = {
              ...row.paragraph,
              text: row.text,
              id: String(reference.paragraphId),
              novelId: row.book_id,
              chapterId: request.params.chapterId,
            };
            if (
              plainTTSParagraphHash(paragraph) !== reference.paragraphHash ||
              (body.contentRevision ?? null) !== row.active_content_revision_id
            )
              throw new PlainTTSError(409, '본문이 변경되었습니다. 회차를 다시 열어주세요.');
            return { row, paragraph };
          };
          if (!sample) {
            if (
              typeof body.paragraphId !== 'string' ||
              typeof body.paragraphHash !== 'string' ||
              typeof body.chunkHash !== 'string'
            )
              throw new PlainTTSError(400, '원문 위치가 필요합니다.');
            if (
              body.chunking !== undefined &&
              body.chunking !== 'sentence' &&
              body.chunking !== 'paragraph' &&
              body.chunking !== 'batch'
            )
              throw new PlainTTSError(400, '낭독 단위를 확인하세요.');
            const rules = parsePlainTTSRules(body.rules);
            const { row, paragraph } = await loadSource();
            let item;
            if (body.batch !== undefined) {
              if (
                body.chunking !== 'batch' ||
                !Array.isArray(body.batch) ||
                body.batch.length < 2 ||
                body.batch.length > 16 ||
                body.batch.some(
                  (ref) => !ref || typeof ref.paragraphId !== 'string' || typeof ref.paragraphHash !== 'string',
                ) ||
                body.batch[0].paragraphId !== body.paragraphId ||
                body.batch[0].paragraphHash !== body.paragraphHash
              )
                throw new PlainTTSError(400, '묶음 원문 위치가 올바르지 않습니다.');
              const loaded = await Promise.all(body.batch.map((ref) => loadSource(ref)));
              if (
                loaded.some(
                  (entry, index) =>
                    entry.row.book_id !== row.book_id ||
                    (index > 0 && entry.row.paragraph_index <= loaded[index - 1].row.paragraph_index),
                )
              )
                throw new PlainTTSError(400, '묶음 원문 순서가 올바르지 않습니다.');
              item = buildPlainTTSBatch({
                paragraphs: loaded.map((entry) => entry.paragraph),
                language: row.language,
                rules,
                rate,
              });
              if (item?.spokenTextFingerprint !== body.chunkHash) item = undefined;
            } else {
              item = buildPlainTTSItems({
                paragraph,
                language: row.language,
                rules,
                rate,
                chunking: body.chunking,
              }).find((item) => item.spokenTextFingerprint === body.chunkHash);
            }
            if (!item) throw new PlainTTSError(409, '낭독할 문장이 원문과 일치하지 않습니다.');
            text = item.text;
            sourceKey = {
              book: row.book_id,
              chapter: request.params.chapterId,
              paragraph: body.paragraphId,
              revision: row.active_content_revision_id,
              source: body.paragraphHash,
              chunk: body.chunkHash,
              batch: body.batch,
            };
          }
          const key = structuredIntegrityHash({
            version: 'plain-tts-v1',
            user: config.defaultUserId,
            sourceKey,
            provider: source.id,
            modelId: source.modelId,
            revision: source.revision,
            voiceId,
            rate,
            text,
          });
          const audio = await synthesize(key, text, selectedVoice.id, rate, source);
          // Ownership and revision may change while inference runs.
          if (!sample) {
            await loadSource();
            if (Array.isArray(body.batch)) await Promise.all(body.batch.map((ref) => loadSource(ref)));
          }
          return reply.header('Cache-Control', 'private, no-store').type(audio.contentType).send(audio.data);
        } catch (error) {
          if (error instanceof PlainTTSError) {
            if (error.retryAfterSeconds) reply.header('Retry-After', error.retryAfterSeconds);
            return reply.code(error.status).send({
              error: error.message,
              ...(error.status === 429
                ? { code: 'tts_rate_limited', retryAfterSeconds: error.retryAfterSeconds ?? 5 }
                : {}),
            });
          }
          const failure = classifyPlainTTSFailure(error);
          // Never log the provider response, document text, credentials, or request body.
          app.log.warn({
            event: 'plain_tts_failed',
            errorCategory: failure.code,
            upstreamStatus: failure.upstreamStatus,
          });
          return reply.code(failure.status).send({ error: failure.message, code: failure.code });
        }
      },
    );
  }
}

class PlainTTSError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function parsePlainTTSRules(value: unknown): SpokenTextRule[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new PlainTTSError(400, '발음 규칙은 최대 100개까지 지원합니다.');
  return value.map((rule) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' ||
      rule.id.length > 160 ||
      !['global', 'book'].includes(rule.scope) ||
      !['replace_literal', 'replace_regex', 'skip_line', 'skip_prefix', 'skip_suffix'].includes(rule.kind) ||
      typeof rule.pattern !== 'string' ||
      !rule.pattern ||
      rule.pattern.length > 256 ||
      (rule.replacement !== undefined && (typeof rule.replacement !== 'string' || rule.replacement.length > 256)) ||
      typeof rule.enabled !== 'boolean' ||
      typeof rule.priority !== 'number' ||
      !Number.isFinite(rule.priority)
    )
      throw new PlainTTSError(400, '발음 규칙이 올바르지 않습니다.');
    if (rule.kind === 'replace_literal' || rule.kind === 'replace_regex') {
      const error = validateSpokenTextFilter(rule);
      if (error) throw new PlainTTSError(400, error);
    }
    return {
      id: rule.id,
      scope: rule.scope,
      kind: rule.kind,
      pattern: rule.pattern,
      replacement: rule.replacement,
      enabled: rule.enabled,
      priority: rule.priority,
      updatedAt: '',
    };
  });
}

export function classifyPlainTTSFailure(error: unknown): {
  status: number;
  code: string;
  message: string;
  upstreamStatus?: number;
} {
  const value =
    error && typeof error === 'object'
      ? (error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown })
      : {};
  const rawStatus = value.status ?? value.code;
  const upstreamStatus = typeof rawStatus === 'number' && Number.isInteger(rawStatus) ? rawStatus : undefined;
  if (upstreamStatus === 429)
    return {
      status: 429,
      upstreamStatus,
      code: 'tts_rate_limited',
      message:
        '음성 제공자의 요청 한도 또는 처리 용량에 도달했습니다. 잠시 후 다시 재생하세요. 문단 단위로 읽으면 요청 횟수를 줄일 수 있습니다.',
    };
  if (value.name === 'TimeoutError' || value.name === 'AbortError' || upstreamStatus === 504)
    return {
      status: 504,
      upstreamStatus,
      code: 'tts_timeout',
      message:
        '음성 생성 응답이 늦어 중단되었습니다. 잠시 후 다시 재생하세요. 긴 문단은 문장 단위로 바꾸면 도움이 될 수 있습니다.',
    };
  if (upstreamStatus === 401 || upstreamStatus === 403)
    return {
      status: 502,
      upstreamStatus,
      code: 'tts_access_denied',
      message: '음성 제공자 인증 또는 사용 권한을 확인하세요. TTS 엔진 연결 설정에서 확인할 수 있습니다.',
    };
  if (
    value.message === 'Gemini Vertex TTS returned no audio data' ||
    value.message === 'Gemini TTS returned no audio data'
  )
    return {
      status: 502,
      upstreamStatus,
      code: 'tts_no_audio',
      message:
        '음성 제공자가 이 문장의 음성을 반환하지 않았습니다. 문단 단위로 바꾸거나 다른 목소리를 선택해 다시 재생하세요.',
    };
  return {
    status: 502,
    upstreamStatus,
    code: 'tts_provider_failed',
    message: '서버 음성을 생성하지 못했습니다. 잠시 후 다시 재생하거나 다른 목소리를 선택하세요.',
  };
}
