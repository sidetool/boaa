import { isUiJson, uiKeys, uiRecord, type UiJson } from './ui-json';
export const PLUGIN_HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export interface PluginHttpOwner {
  profileId: string;
  installationId: string;
  digest: string;
  generation: number;
}
export interface PluginHttpRequest {
  slot: string;
  path: string;
  method: (typeof PLUGIN_HTTP_METHODS)[number];
  headers?: Record<string, string>;
  body?: string;
  response: 'text' | 'json';
  /** JSON field paths; * maps every array item or object value without reordering. */
  pick?: string[][];
}
export function pluginJsonPick(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 48 &&
    value.every(
      (path) =>
        Array.isArray(path) &&
        path.length > 0 &&
        path.length <= 8 &&
        path.every(
          (part) =>
            typeof part === 'string' &&
            (part === '*' || /^[a-zA-Z0-9_-]{1,64}$/.test(part)) &&
            !['__proto__', 'prototype', 'constructor'].includes(part),
        ),
    )
  );
}
export const pluginSlot = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(v);
export function pluginHttpOwner(v: unknown): v is PluginHttpOwner {
  const uuid = (s: unknown) => typeof s === 'string' && /^[a-f0-9-]{36}$/i.test(s);
  return (
    uiRecord(v) &&
    uiKeys(v, ['profileId', 'installationId', 'digest', 'generation']) &&
    uuid(v.profileId) &&
    uuid(v.installationId) &&
    typeof v.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(v.digest) &&
    Number.isSafeInteger(v.generation) &&
    Number(v.generation) > 0
  );
}
export function pluginHttpRequest(v: unknown): v is PluginHttpRequest {
  return (
    isUiJson(v, 32 * 1024) &&
    uiRecord(v) &&
    uiKeys(v, ['slot', 'path', 'method', 'response'], ['headers', 'body', 'pick']) &&
    pluginSlot(v.slot) &&
    typeof v.path === 'string' &&
    v.path.length <= 2048 &&
    PLUGIN_HTTP_METHODS.includes(v.method as PluginHttpRequest['method']) &&
    ['text', 'json'].includes(String(v.response)) &&
    (v.pick === undefined || (v.response === 'json' && pluginJsonPick(v.pick))) &&
    (v.body === undefined || (typeof v.body === 'string' && !['GET', 'HEAD'].includes(String(v.method)))) &&
    (v.headers === undefined ||
      (uiRecord(v.headers) &&
        Object.keys(v.headers).length <= 16 &&
        Object.entries(v.headers).every(
          ([k, value]) =>
            /^[a-z][a-z0-9-]{0,63}$/.test(k) &&
            typeof value === 'string' &&
            value.length <= 1024 &&
            !/[\r\n\0]/.test(value),
        )))
  );
}
export function pluginEndpoint(raw: string): URL {
  const u = new URL(raw);
  if (
    !['https:', 'http:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !u.pathname.endsWith('/') ||
    /[%\\]/.test(u.pathname) ||
    raw.length > 2048
  )
    throw Error('HTTP_ENDPOINT_DENIED');
  return u;
}
export function pluginTarget(endpoint: string, path: string): URL {
  const base = pluginEndpoint(endpoint);
  // Paths are relative to the approved directory. Reject encoded separators/dot segments,
  // including nested encoding, so reverse proxy normalization cannot escape that directory.
  if (
    /^[/\\]/.test(path) ||
    /[\\#]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) <= 32) ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    /%(?:2e|2f|5c|25|00)/i.test(path.split('?')[0])
  )
    throw Error('HTTP_PATH_DENIED');
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw Error('HTTP_PATH_DENIED');
  return url;
}

export type PluginHttpResult =
  | { ok: true; status: number; headers: Record<string, string>; body: UiJson }
  | { ok: false; code: 'HTTP_FAILED' | 'HTTP_CANCELLED'; outcome: 'not-sent' | 'failed' | 'unknown' };
