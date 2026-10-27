import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../../config.js';
import { requireAdmin } from '../../auth.js';
import { audiobookError } from '../../services/audiobook-plan.js';
import type { VoiceLibraryStore } from '../../services/voice-library-store.js';
import type { VoiceLibraryInput, VoiceDesignInput, LibraryVoice } from '../../../../../src/providers/voice-library';

export async function registerVoiceLibraryRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  store: VoiceLibraryStore,
  sample: (voice: LibraryVoice) => Promise<{ data: Buffer; contentType: string }>,
) {
  const lifetime = new AbortController();
  app.addHook('onClose', async () => lifetime.abort());
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (req, reply) => {
      if (requireAdmin(req).userId !== config.defaultUserId)
        throw audiobookError(403, '목소리를 관리할 수 없는 계정이에요.');
      reply.header('Cache-Control', 'private, no-store');
    });
    routes.get('/api/tts/voice-library', () => store.list());
    routes.post<{ Body: VoiceLibraryInput }>('/api/tts/voice-library', { bodyLimit: 16384 }, (req) =>
      store.save(req.body),
    );
    routes.put<{ Params: { id: string }; Body: VoiceLibraryInput }>(
      '/api/tts/voice-library/:id',
      { bodyLimit: 16384 },
      (req) => store.save(req.body, req.params.id),
    );
    routes.delete<{ Params: { id: string } }>('/api/tts/voice-library/:id', async (req) => {
      await store.remove(req.params.id);
      return { ok: true };
    });
    routes.post<{ Body: VoiceDesignInput }>('/api/tts/voice-library/design', { bodyLimit: 16384 }, async (req) => {
      try {
        return await store.design(req.body, AbortSignal.any([lifetime.signal, AbortSignal.timeout(120000)]));
      } catch (e) {
        if ((e as { status?: number }).status === 429)
          throw Object.assign(audiobookError(429, '목소리 제작 요청 한도에 도달했어요. 잠시 후 다시 시도해 주세요.'), {
            retryAfterSeconds: (e as { retryAfterSeconds?: number }).retryAfterSeconds,
          });
        throw e;
      }
    });
    routes.post<{ Params: { id: string } }>('/api/tts/voice-library/:id/sample', async (req, reply) => {
      const saved = await store.sample(req.params.id);
      const audio = saved.audio ?? (await sample(saved.voice));
      await store.authority();
      return reply.type(audio.contentType).send(audio.data);
    });
  });
}
