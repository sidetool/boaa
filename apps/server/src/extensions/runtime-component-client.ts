import { readFile } from 'node:fs/promises';
import { parseOutboundProxy } from './outbound-proxy.js';

export function runtimeComponentEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('runtime_endpoint_invalid');
  return endpoint;
}

export async function runtimeComponentToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = env.BOAA_RUNTIME_TOKEN_FILE
    ? (await readFile(env.BOAA_RUNTIME_TOKEN_FILE, 'utf8')).trim()
    : env.BOAA_RUNTIME_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('runtime_token_invalid');
  return token;
}

export async function readRuntimeJson(response: Response, maximum = 4096): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('runtime_manifest_invalid');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('runtime_manifest_invalid');
      chunks.push(value);
    }
    const manifest: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      throw new Error('runtime_manifest_invalid');
    return manifest as Record<string, unknown>;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

/** Use only for an explicitly selected managed runtime; external collector settings keep their own credentials. */
export function createManagedMetadataFetch(options: {
  endpoint: string;
  resolveDefaultProxy: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const endpoint = runtimeComponentEndpoint(options.endpoint);
  const upstream = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== endpoint.origin ||
      !(
        url.pathname === '/health' ||
        url.pathname === '/healthz' ||
        url.pathname === '/v1/manifest' ||
        url.pathname.startsWith('/api/v1/')
      )
    )
      throw new Error('runtime_path_denied');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${await runtimeComponentToken(options.env)}`);
    headers.set('X-Boaa-Runtime-Protocol', '1');
    headers.set('X-Boaa-Outbound-Proxy', parseOutboundProxy(options.resolveDefaultProxy()) ?? 'direct');
    return upstream(input, { ...init, headers, redirect: 'manual', credentials: 'omit' });
  };
}
