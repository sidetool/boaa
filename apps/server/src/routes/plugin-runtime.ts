import { pluginScope } from '../plugins/plugin-scope.js';
export { pluginScope } from '../plugins/plugin-scope.js';
import { registerPluginConnectionRoutes } from './plugin-connections.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { requestCookie, SELF_HOST_SESSION_COOKIE } from '../auth-cookie.js';
import { pluginOriginFromEnv, type ServerConfig } from '../config.js';

export function pluginShell(bootstrap: string, origin: string) {
  if (pluginOriginFromEnv(origin) !== origin) throw Error('INVALID_PLUGIN_ORIGIN');
  const script = `const __BOAA_CONFIGURED_PARENT_ORIGIN__=${JSON.stringify(origin)};\n${bootstrap}`.replace(
    /<\/script/gi,
    '<\\/script',
  );
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    csp: `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${hash}' blob:; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOAA plugin</title></head><body><main id="boaa-plugin-root"></main><script>${script}</script></body></html>`,
  };
}

export async function registerPluginRuntimeRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  pool: pg.Pool,
  assets: URL,
) {
  const origin = pluginOriginFromEnv(config.pluginOrigin);
  if (!origin) return;
  registerPluginConnectionRoutes(app, config, pool);
  // A missing/corrupt deployment fails startup instead of serving a half-functional runtime.
  const [bootstrap, worker, wasm] = await Promise.all([
    readFile(new URL('view-bootstrap.js', assets), 'utf8'),
    readFile(new URL('controller-worker.js', assets)),
    readFile(new URL('quickjs.wasm', assets)),
  ]);
  const shell = pluginShell(bootstrap, origin);
  const files = {
    shell: { body: shell.html, type: 'text/html; charset=utf-8', csp: shell.csp },
    'controller-worker.js': {
      body: worker,
      type: 'application/javascript',
      csp: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
    },
    'quickjs.wasm': { body: wasm, type: 'application/wasm', csp: "default-src 'none'" },
  };
  for (const [name, asset] of Object.entries(files)) {
    app.get(`/plugin-runtime/${name}`, async (_request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', asset.csp)
        .type(asset.type)
        .send(asset.body),
    );
  }
  app.get('/api/plugins/context', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
    const token = requestCookie(request, SELF_HOST_SESSION_COOKIE);
    if (!token || token.length > 512) return reply.code(401).send({ error: 'plugin_account_required' });
    const scope = await pluginScope(pool, token, config.defaultUserId);
    if (!scope) return reply.code(401).send({ error: 'plugin_account_required' });
    return {
      version: 1,
      origin,
      ...scope,
      worker: '/plugin-runtime/controller-worker.js',
      wasm: '/plugin-runtime/quickjs.wasm',
      shell: '/plugin-runtime/shell',
    };
  });
}
