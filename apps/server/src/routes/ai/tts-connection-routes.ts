import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { requireAdmin } from '../../auth.js';
import { TTSConnectionStore } from '../../providers/tts-connections.js';

export async function registerTTSConnectionRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  store = new TTSConnectionStore(pool, config),
) {
  const active = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const controller of active) controller.abort();
    active.clear();
  });
  for (const operation of ['list', 'create', 'update', 'delete', 'probe', 'probeSaved'] as const) {
    app.route<{ Params: { id?: string }; Body: unknown }>({
      method:
        operation === 'list' ? 'GET' : operation === 'delete' ? 'DELETE' : operation === 'update' ? 'PUT' : 'POST',
      url:
        '/api/tts/connections' +
        (['update', 'delete', 'probeSaved'].includes(operation) ? '/:id' : '') +
        (operation.startsWith('probe') ? '/probe' : ''),
      bodyLimit: 32 * 1024,
      async handler(request, reply) {
        const principal = requireAdmin(request);
        if (principal.userId !== config.defaultUserId)
          return reply.code(403).send({ error: 'provider_capability_unavailable' });
        reply.header('Cache-Control', 'private, no-store');
        const controller = new AbortController();
        const cancel = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        request.raw.once('aborted', cancel);
        reply.raw.once('close', cancel);
        const timer = setTimeout(() => controller.abort(), 25_000);
        active.add(controller);
        try {
          if (operation === 'list') return { connections: await store.list() };
          if (operation === 'delete') {
            await store.remove(request.params.id!);
            return { ok: true };
          }
          if (operation.startsWith('probe')) {
            // A small explicit admin-only budget; never let repeated discovery hold arbitrary sockets.
            if (active.size > 3)
              return reply.code(429).send({ error: '다른 연결을 확인하고 있어요. 잠시 후 다시 시도해 주세요.' });
            return await store.probe(request.body, controller.signal, request.params.id);
          }
          controller.signal.throwIfAborted();
          return await store.save(request.body, request.params.id);
        } catch (error) {
          const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
          return reply.code(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500).send({
            error:
              status !== 500 && error instanceof Error
                ? error.message
                : 'TTS 서버 설정을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
          });
        } finally {
          clearTimeout(timer);
          active.delete(controller);
          request.raw.removeListener('aborted', cancel);
          reply.raw.removeListener('close', cancel);
        }
      },
    });
  }
}
