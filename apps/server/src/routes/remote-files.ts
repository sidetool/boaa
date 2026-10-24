import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth.js';
import { remoteFileProtocol } from '../../../../packages/extension-contracts/remote-files.js';
import type { RemoteFileService } from '../remote-files/service.js';
const safeCodes = new Set([
  'invalid_connection',
  'invalid_path',
  'invalid_protocol',
  'invalid_host',
  'invalid_host_key',
  'https_required',
  'credentials_required',
  'authentication',
  'not_found',
  'redirect',
  'upstream',
  'listing_limit',
  'invalid_response',
  'timeout',
  'size_limit',
  'host_key_changed',
  'not_file',
  'busy',
  'connection_limit',
  'connection_changed',
  'not_connected',
  'unsupported_file',
  'invalid_request',
  'unavailable',
]);
export async function registerRemoteFileRoutes(app: FastifyInstance, service: RemoteFileService) {
  const lifetimes = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const c of lifetimes) c.abort();
    lifetimes.clear();
  });
  for (const operation of ['statuses', 'connect', 'status', 'update', 'disconnect', 'list', 'download'] as const) {
    app.route<{ Params: { id?: string }; Body: Record<string, unknown> }>({
      method:
        operation === 'status' || operation === 'statuses'
          ? 'GET'
          : operation === 'disconnect'
            ? 'DELETE'
            : operation === 'update'
              ? 'PUT'
              : 'POST',
      url:
        '/api/remote-files' +
        (operation === 'statuses' || operation === 'connect' ? '' : '/:id') +
        (operation === 'list' || operation === 'download' ? '/' + operation : ''),
      bodyLimit: 32 * 1024,
      async handler(request, reply) {
        const owner = requireAdmin(request).userId;
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
        const abort = new AbortController();
        lifetimes.add(abort);
        const cancel = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        request.raw.once('aborted', cancel);
        reply.raw.once('close', cancel);
        const timer = setTimeout(() => abort.abort(), operation === 'download' ? 300_000 : 30_000);
        let streaming = false;
        const cleanup = () => {
          clearTimeout(timer);
          lifetimes.delete(abort);
          request.raw.removeListener('aborted', cancel);
          reply.raw.removeListener('close', cancel);
        };
        try {
          if (operation === 'statuses') return { connections: service.statuses(owner) };
          const id = request.params.id ?? '';
          if (id && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('remote_files_invalid_request');
          if (operation === 'status') return service.status(owner, id);
          if (operation === 'disconnect') return service.disconnect(owner, id);
          if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))
            throw new Error('remote_files_invalid_request');
          if (operation === 'connect' || operation === 'update')
            return await service.connect(
              owner,
              remoteFileProtocol(request.body.protocol),
              request.body,
              abort.signal,
              operation === 'update' ? id : undefined,
            );
          if (operation === 'list') return await service.list(owner, id, request.body, abort.signal);
          const stream = await service.download(owner, id, request.body, abort.signal);
          streaming = true;
          stream.once('close', cleanup);
          return reply.type('application/octet-stream').header('Content-Disposition', 'attachment').send(stream);
        } catch (error) {
          const message = error instanceof Error ? error.message : '',
            code = message.replace(/^remote_files_/, '');
          const safe =
            message.startsWith('remote_files_') && safeCodes.has(code)
              ? code
              : abort.signal.aborted
                ? 'timeout'
                : 'unavailable';
          return reply
            .code(
              safe === 'busy'
                ? 429
                : safe === 'connection_changed'
                  ? 409
                  : safe.startsWith('invalid') || safe === 'https_required' || safe === 'credentials_required'
                    ? 400
                    : 502,
            )
            .send({ error: 'remote_files_' + safe });
        } finally {
          if (!streaming) cleanup();
        }
      },
    });
  }
}
