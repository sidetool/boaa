import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { SpokenTextRule } from '@boaa/contracts';
import type { ServerConfig } from '../../config.js';
import { requireAdmin } from '../../auth.js';
import type { AudiobookInput } from '../../../../../src/providers/plain-audiobook';
import type { PlainTTSRequest, PlainTTSVoices, PlainTTSModel } from '../../../../../src/providers/plain-tts';
import { AudiobookAudioStore, type SavedAudio } from '../../services/audiobook-audio.js';
import { AudiobookService } from '../../services/audiobook-service.js';
import { audiobookError, validateAudiobookInput } from '../../services/audiobook-plan.js';

export async function registerAudiobookRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  options: {
    audioStore: AudiobookAudioStore;
    catalog(): Promise<PlainTTSVoices>;
    render(chapterId: string, request: PlainTTSRequest, model?: PlainTTSModel): Promise<SavedAudio>;
    resolveModel?: (
      settings: AudiobookInput,
      probe: { chapterId: string; request: PlainTTSRequest; key?: string },
    ) => Promise<PlainTTSModel>;
    rules(input: unknown): SpokenTextRule[];
    failure(error: unknown): { status: number; message: string };
    background?: boolean;
  },
) {
  const service = new AudiobookService(
    pool,
    config.defaultUserId,
    options.audioStore,
    options.catalog,
    options.render,
    options.failure,
    options.resolveModel,
  );
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request) => {
      const actor = requireAdmin(request);
      if (actor.userId !== config.defaultUserId) throw audiobookError(403, '이 계정은 서버 음성을 사용할 수 없습니다.');
    });
    const input = (body: unknown): AudiobookInput => {
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw audiobookError(400, '생성 설정을 확인해 주세요.');
      const value = body as AudiobookInput;
      let rules: SpokenTextRule[];
      try {
        rules = options.rules(value.rules);
      } catch {
        throw audiobookError(400, '발음 규칙을 확인해 주세요.');
      }
      const result = {
        chapterIds: value.chapterIds,
        voiceId: value.voiceId,
        modelRevision: value.modelRevision,
        chunking: value.chunking,
        batchCharacters: value.batchCharacters,
        footnotePlayback: value.footnotePlayback,
        rules,
      };
      validateAudiobookInput(result);
      return result;
    };
    routes.get<{ Params: { bookId: string } }>('/api/books/:bookId/audiobooks', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return { audiobooks: await service.list(request.params.bookId) };
    });
    routes.get<{ Params: { bookId: string }; Querystring: { chapterId: string; id?: string; voiceId?: string } }>(
      '/api/books/:bookId/audiobooks/reader',
      async (request, reply) => {
        const { chapterId, id, voiceId } = request.query;
        if (
          typeof chapterId !== 'string' ||
          chapterId.length > 256 ||
          (id !== undefined && (typeof id !== 'string' || id.length > 64)) ||
          (voiceId !== undefined && (typeof voiceId !== 'string' || voiceId.length > 512))
        )
          throw audiobookError(400, '낭독 위치를 확인해 주세요.');
        reply.header('Cache-Control', 'private, no-store');
        return { plan: await service.reader(request.params.bookId, chapterId, { id, voiceId }) };
      },
    );
    routes.post<{ Params: { id: string; ordinal: string }; Body?: { regenerate?: boolean } }>(
      '/api/audiobooks/:id/resolve/:ordinal',
      { bodyLimit: 1024 },
      async (request, reply) => {
        if (request.body?.regenerate !== undefined && typeof request.body.regenerate !== 'boolean')
          throw audiobookError(400, '재시도 요청을 확인해 주세요.');
        const release = app.beginBackgroundWork ? app.beginBackgroundWork() : () => {};
        if (!release) throw audiobookError(503, '서버 업데이트 중입니다. 잠시 후 다시 재생해 주세요.');
        try {
          const audio = await service.resolve(
            request.params.id,
            Number(request.params.ordinal),
            request.body?.regenerate === true,
          );
          return reply.header('Cache-Control', 'private, no-store').type(audio.contentType).send(audio.data);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode) throw error;
          const failure = options.failure(error);
          return reply.code(failure.status).send({
            error: failure.message,
            ...(failure.status === 429
              ? {
                  code: 'tts_rate_limited',
                  retryAfterSeconds: (error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 5,
                }
              : {}),
          });
        } finally {
          release();
        }
      },
    );
    routes.post<{ Params: { bookId: string }; Body: AudiobookInput }>(
      '/api/books/:bookId/audiobooks/estimate',
      { bodyLimit: 256 * 1024 },
      async (request) => (await service.plan(request.params.bookId, input(request.body))).estimate,
    );
    routes.post<{ Params: { bookId: string }; Body: AudiobookInput & { fingerprint: string; confirmPaid: boolean } }>(
      '/api/books/:bookId/audiobooks',
      { bodyLimit: 256 * 1024 },
      async (request) =>
        service.create(
          await service.plan(request.params.bookId, input(request.body)),
          request.body.fingerprint,
          request.body.confirmPaid === true,
        ),
    );
    routes.post<{ Params: { id: string }; Body: { action: 'pause' | 'resume'; confirmPaid?: boolean } }>(
      '/api/audiobooks/:id/control',
      async (request) => {
        if (!request.body || !['pause', 'resume'].includes(request.body.action))
          throw audiobookError(400, '작업을 확인해 주세요.');
        return service.control(request.params.id, request.body.action, request.body.confirmPaid === true);
      },
    );
    routes.delete<{ Params: { id: string } }>('/api/audiobooks/:id', async (request) => {
      await service.remove(request.params.id);
      return { ok: true };
    });
    routes.get<{ Params: { id: string; ordinal: string } }>(
      '/api/audiobooks/:id/audio/:ordinal',
      async (request, reply) => {
        const audio = await service.audio(request.params.id, Number(request.params.ordinal));
        return reply
          .header('Cache-Control', 'private, no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .type(audio.contentType)
          .send(audio.data);
      },
    );
    routes.post<{ Params: { id: string }; Body: { index: number } }>(
      '/api/audiobooks/:id/progress',
      async (request) => {
        await service.progress(request.params.id, request.body?.index);
        return { ok: true };
      },
    );
  });
  let stopping = false;
  let work: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (stopping) return;
    const release = app.beginBackgroundWork ? app.beginBackgroundWork() : () => {};
    if (!release) {
      timer = setTimeout(run, 1000);
      timer.unref();
      return;
    }
    work = service
      .tick()
      .catch(() => {
        app.log.warn({ event: 'audiobook_runner_failed' });
      })
      .finally(() => {
        release();
        work = undefined;
        if (!stopping) {
          timer = setTimeout(run, 1000);
          timer.unref();
        }
      });
  };
  if (options.background !== false)
    app.addHook('onReady', async () => {
      timer = setTimeout(run, 1000);
      timer.unref();
    });
  app.addHook('onClose', async () => {
    stopping = true;
    clearTimeout(timer);
    try {
      await service.stop();
    } finally {
      await work;
    }
  });
  return service;
}
