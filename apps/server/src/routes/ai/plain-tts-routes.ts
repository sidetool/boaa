import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Paragraph, SpokenTextRule, VoiceProfile } from '@boaa/contracts';
import { buildPlainTTSItems, plainTTSParagraphHash, PLAIN_TTS_SAMPLE } from '../../../../../src/providers/plain-tts';
import type { TTSVoice, TTSSynthesisProvider } from '../../../../../src/providers/tts';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { ServerConfig } from '../../config.js';
import { createServerTTSSynthesisProvider } from '../../providers/server-tts-provider-factory.js';

type SourceRow = {
  paragraph: Paragraph;
  text: string;
  book_id: string;
  language: string;
  active_content_revision_id: string | null;
};
type Audio = { data: Buffer; contentType: string };

/** Local, bounded and analysis-independent. Never dispatches a paid provider job. */
export async function registerPlainTTSRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  options: { env?: NodeJS.ProcessEnv; provider?: TTSSynthesisProvider } = {},
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
  let catalog: { voices: TTSVoice[]; expires: number } | undefined;
  let loadingVoices: Promise<TTSVoice[]> | undefined;
  const voices = async (): Promise<TTSVoice[]> => {
    if (!provider) return [];
    if (catalog && catalog.expires > Date.now()) return catalog.voices;
    loadingVoices ??= provider.listVoices!()
      .then((items) => {
        catalog = { voices: items, expires: Date.now() + 30_000 };
        return items;
      })
      .finally(() => {
        loadingVoices = undefined;
      });
    return loadingVoices;
  };
  // Restarting the API drops this cache. Model weights remain in the model service's persistent volume.
  const cache = new Map<string, Audio>();
  let cacheBytes = 0;
  const pending = new Map<string, Promise<Audio>>();
  const maxBytes = 64 * 1024 * 1024;
  async function synthesize(key: string, text: string, voiceId: string, rate: number): Promise<Audio> {
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
      const now = new Date().toISOString();
      const profile: VoiceProfile = {
        id: 'plain-default',
        novelId: '',
        role: 'narrator',
        providerId: 'local-endpoint',
        providerVoiceId: voiceId,
        label: voiceId,
        language: 'ko',
        speed: 1,
        pitch: 1,
        emotionPolicy: 'neutral',
        isUserSelected: true,
        createdAt: now,
        updatedAt: now,
      };
      const result = await provider!.synthesize({
        text,
        voiceProfile: profile,
        speed: rate,
        format: 'wav',
        signal: AbortSignal.timeout(45_000),
      });
      const audio = { data: Buffer.from(result.audio), contentType: result.contentType };
      if (!audio.contentType.startsWith('audio/') || !audio.data.length || audio.data.length > 16 * 1024 * 1024)
        throw new PlainTTSError(502, '서버 음성의 오디오 응답이 올바르지 않습니다.');
      while (cacheBytes + audio.data.length > maxBytes && cache.size) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.data.length;
        cache.delete(oldest);
      }
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
    if (!provider)
      return {
        available: false,
        voices: [],
        message: '서버에 기본 낭독 모델이 설치되지 않았습니다. 기기 목소리를 사용할 수 있습니다.',
      };
    try {
      const items = await voices();
      return { available: items.length > 0, voices: items, modelId, revision };
    } catch {
      return reply.code(503).send({ error: '서버 음성 모델에 연결하지 못했습니다.' });
    }
  });

  for (const sample of [false, true]) {
    app.post<{ Params: { chapterId: string }; Body: Record<string, unknown> }>(
      sample ? '/api/tts/plain/sample' : '/api/chapters/:chapterId/tts/plain',
      { bodyLimit: 64 * 1024 },
      async (request, reply) => {
        try {
          if (!provider) throw new PlainTTSError(503, '서버 기본 음성이 설치되지 않았습니다.');
          const body = request.body;
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new PlainTTSError(400, '낭독 요청이 올바르지 않습니다.');
          const { voiceId, rate, modelRevision } = body;
          if (
            typeof voiceId !== 'string' ||
            voiceId.length > 160 ||
            typeof rate !== 'number' ||
            !Number.isFinite(rate) ||
            rate < 0.5 ||
            rate > 2.5
          )
            throw new PlainTTSError(400, '목소리 또는 속도가 올바르지 않습니다.');
          if (modelRevision !== revision)
            throw new PlainTTSError(409, '서버 모델이 변경되었습니다. 목소리 목록을 새로고침하세요.');
          if (!(await voices()).some((voice) => voice.id === voiceId))
            throw new PlainTTSError(400, '선택한 목소리를 찾을 수 없습니다.');
          let text = PLAIN_TTS_SAMPLE;
          let sourceKey: unknown = { sample: 1 };
          const loadSource = async () => {
            const result = await pool.query<SourceRow>(
              `
              select p.paragraph, p.text, p.book_id, b.language, b.active_content_revision_id
              from paragraph_search p join library_books b on b.id = p.book_id
              where p.chapter_id = $1 and p.paragraph_id = $2 and b.user_id = $3 and b.deleted_at is null
            `,
              [request.params.chapterId, body.paragraphId, config.defaultUserId],
            );
            const row = result.rows[0];
            if (!row) throw new PlainTTSError(404, '원문 문단을 찾을 수 없습니다.');
            const paragraph = {
              ...row.paragraph,
              text: row.text,
              id: String(body.paragraphId),
              novelId: row.book_id,
              chapterId: request.params.chapterId,
            };
            if (
              plainTTSParagraphHash(paragraph) !== body.paragraphHash ||
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
            const rules = parsePlainTTSRules(body.rules);
            const { row, paragraph } = await loadSource();
            const item = buildPlainTTSItems({ paragraph, language: row.language, rules, rate }).find(
              (item) => item.spokenTextFingerprint === body.chunkHash,
            );
            if (!item) throw new PlainTTSError(409, '낭독할 문장이 원문과 일치하지 않습니다.');
            text = item.text;
            sourceKey = {
              book: row.book_id,
              chapter: request.params.chapterId,
              paragraph: body.paragraphId,
              revision: row.active_content_revision_id,
              source: body.paragraphHash,
              chunk: body.chunkHash,
            };
          }
          const key = structuredIntegrityHash({
            version: 'plain-tts-v1',
            user: config.defaultUserId,
            sourceKey,
            modelId,
            revision,
            voiceId,
            rate,
            text,
          });
          const audio = await synthesize(key, text, voiceId, rate);
          // Ownership and revision may change while inference runs.
          if (!sample) await loadSource();
          return reply.header('Cache-Control', 'private, no-store').type(audio.contentType).send(audio.data);
        } catch (error) {
          if (error instanceof PlainTTSError) return reply.code(error.status).send({ error: error.message });
          return reply
            .code(502)
            .send({ error: '서버 음성을 생성하지 못했습니다. 다시 재생하거나 기기 목소리를 선택하세요.' });
        }
      },
    );
  }
}

class PlainTTSError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
      !['replace_literal', 'skip_line', 'skip_prefix', 'skip_suffix'].includes(rule.kind) ||
      typeof rule.pattern !== 'string' ||
      !rule.pattern ||
      rule.pattern.length > 256 ||
      (rule.replacement !== undefined && (typeof rule.replacement !== 'string' || rule.replacement.length > 256)) ||
      typeof rule.enabled !== 'boolean' ||
      typeof rule.priority !== 'number' ||
      !Number.isFinite(rule.priority)
    )
      throw new PlainTTSError(400, '발음 규칙이 올바르지 않습니다.');
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
