import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from '../config';
import { requireUserId } from '../auth';
import { requestCookie, SELF_HOST_SESSION_COOKIE } from '../auth-cookie';
import { pluginScope } from '../plugins/plugin-scope';
import { resolvePluginRequestOrigin } from '../plugins/plugin-origin';
import { pluginHttpOwner } from '../../../../packages/extension-contracts/plugin-http';
import { pluginCacheRequest } from '../../../../packages/extension-contracts/plugin-cache';
import { uiKeys, uiRecord } from '../../../../packages/extension-contracts/ui-json';
import { cacheAuthority } from '../plugins/cache-authority';
import { disposableCache } from '../plugins/disposable-cache';

export function registerPluginCacheRoutes(app: FastifyInstance, config: ServerConfig, pool: pg.Pool) {
  app.post('/api/plugins/cache', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
    try {
      const origin = resolvePluginRequestOrigin(req, config),
        token = requestCookie(req, SELF_HOST_SESSION_COOKIE),
        b = req.body;
      if (req.headers.origin !== origin || req.headers['x-boaa-plugin-host'] !== '1' || !token || token.length > 512)
        throw Error('CACHE_DENIED');
      if (
        !uiRecord(b) ||
        !uiKeys(b, ['owner', 'kind', 'role', 'request']) ||
        !pluginHttpOwner(b.owner) ||
        !['home', 'data'].includes(String(b.kind)) ||
        !['controller', 'ui'].includes(String(b.role)) ||
        !pluginCacheRequest(b.request)
      )
        return reply.code(400).send({ error: 'CACHE_INVALID_REQUEST' });
      const scope = await pluginScope(pool, token, requireUserId(req));
      if (!scope) throw Error('CACHE_DENIED');
      const owner = b.owner,
        kind = b.kind as 'home' | 'data',
        role = b.role as 'controller' | 'ui',
        request = b.request;
      return await disposableCache(
        pool,
        { ...scope, installationId: owner.installationId },
        kind,
        request,
        async (db) => {
          const current = await pluginScope(db, token, requireUserId(req));
          if (!current || current.accountId !== scope.accountId || current.libraryId !== scope.libraryId)
            throw Error('CACHE_DENIED');
          return cacheAuthority(db, scope, owner, { kind, role, key: request.key });
        },
      );
    } catch {
      return reply.code(403).send({ error: 'CACHE_UNAVAILABLE' });
    }
  });
}
