import { describe, expect, it } from 'vitest';
import { PLUGIN_CACHE_LIMITS, pluginCacheRequest } from './plugin-cache';

describe('independent disposable cache wire boundaries', () => {
  const set = (key: string, value: unknown, ttlSeconds = 300, staleSeconds = 86400) => ({
    action: 'set',
    key,
    value,
    ttlSeconds,
    staleSeconds,
  });
  it('charges key plus serialized value at the exact combined UTF8 entry boundary', () => {
    const key = '한'.repeat(512),
      bytes = Buffer.byteLength(key);
    const value = 'x'.repeat(PLUGIN_CACHE_LIMITS.entryBytes - bytes - 2);
    expect(Buffer.byteLength(JSON.stringify(value)) + bytes).toBe(PLUGIN_CACHE_LIMITS.entryBytes);
    expect(pluginCacheRequest(set(key, value))).toBe(true);
    expect(pluginCacheRequest(set(key, value + 'x'))).toBe(false);
    expect(pluginCacheRequest(set('a', 'x'.repeat(PLUGIN_CACHE_LIMITS.entryBytes - 2)))).toBe(false);
  });
  it('validates inclusive TTL/stale boundaries without accepting client timestamps', () => {
    for (const ttl of [60, 86400])
      for (const stale of [0, 604800]) expect(pluginCacheRequest(set('key', null, ttl, stale))).toBe(true);
    for (const ttl of [59, 86401, 60.5, NaN]) expect(pluginCacheRequest(set('key', null, ttl))).toBe(false);
    for (const stale of [-1, 604801, 0.5]) expect(pluginCacheRequest(set('key', null, 300, stale))).toBe(false);
    expect(pluginCacheRequest({ ...set('key', 1), savedAt: 1 })).toBe(false);
    expect(pluginCacheRequest({ action: 'set', key: 'key', value: 1 })).toBe(false);
  });
  it('keeps get/remove small and strict and rejects invalid keys/actions', () => {
    for (const action of ['get', 'remove']) {
      expect(pluginCacheRequest({ action, key: 'opaque:cache-key' })).toBe(true);
      expect(pluginCacheRequest({ action, key: 'key', value: 1 })).toBe(false);
      for (const key of ['', 'a'.repeat(513), 'control\n', 4]) expect(pluginCacheRequest({ action, key })).toBe(false);
    }
    expect(pluginCacheRequest({ action: 'clear', key: 'key' })).toBe(false);
    expect(pluginCacheRequest({ action: 'get', key: 'key', owner: {} })).toBe(false);
  });
  it('rejects nonJSON/prototype payloads before database work', () => {
    const circular: unknown[] = [];
    circular.push(circular);
    for (const value of [undefined, NaN, Infinity, BigInt(1), circular, JSON.parse('{"__proto__":{"x":1}}')])
      expect(pluginCacheRequest(set('key', value))).toBe(false);
    expect(pluginCacheRequest(set('key', { items: [], total: 0 }))).toBe(true);
  });
});
