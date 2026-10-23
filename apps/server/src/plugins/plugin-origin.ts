import type { FastifyRequest } from 'fastify';
import { pluginOriginFromEnv, type ServerConfig } from '../config';

/** A configured origin remains an optional pin. Otherwise use only the browser's
 * own secure host, never an arbitrary forwarded Origin or cross-site Referer. */
export function resolvePluginRequestOrigin(request: FastifyRequest, config: ServerConfig): string {
  const deny = () => {
    throw Object.assign(Error('PLUGIN_ORIGIN_DENIED'), { statusCode: 403 });
  };
  if (request.headers['sec-fetch-site'] === 'cross-site') return deny();
  let candidate = request.headers.origin;
  if (!candidate && request.headers.referer) {
    try {
      candidate = new URL(request.headers.referer).origin;
    } catch {
      return deny();
    }
  }
  // Pin-only deployments retain compatibility with non-browser runtime asset requests.
  if (!candidate && config.pluginOrigin) return config.pluginOrigin;
  if (!candidate || candidate === 'null') return deny();
  try {
    const origin = pluginOriginFromEnv(candidate);
    if (!origin) return deny();
    if (config.pluginOrigin) return origin === config.pluginOrigin ? origin : deny();
    const host = request.headers.host;
    return host && new URL(origin).host.toLowerCase() === host.toLowerCase() ? origin : deny();
  } catch {
    return deny();
  }
}
