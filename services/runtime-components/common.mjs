import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export function runtimeManifest(component, env = process.env) {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    component,
    version: env.BOAA_COMPONENT_VERSION || '0.1.0',
    platform: 'linux',
    architecture: { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch,
  };
}

export async function runtimeToken(env = process.env) {
  const token = env.BOAA_RUNTIME_TOKEN_FILE
    ? (await readFile(env.BOAA_RUNTIME_TOKEN_FILE, 'utf8')).trim()
    : env.BOAA_RUNTIME_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('runtime_token_invalid');
  return token;
}

export function authorized(request, token) {
  const value = request.headers.authorization;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(typeof value === 'string' ? value : '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export async function readJson(request, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('runtime_body_limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
