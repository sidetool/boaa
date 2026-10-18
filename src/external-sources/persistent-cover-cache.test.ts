import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistentCoverCache, COVER_RETAIN_MS } from './persistent-cover-cache';
import { SessionCoverCache } from './session-cover-cache';
afterEach(() => vi.unstubAllGlobals());
const key = (id: string) => JSON.stringify(['source', 'generation', id]);
const blob = () => new Blob(['1234'], { type: 'image/png' });

describe('persistent cover blobs', () => {
  it('restores after a new session without downloading and isolates backend/account scopes', async () => {
    const db = `covers-${crypto.randomUUID()}`;
    const disk = new PersistentCoverCache('account-a', 100, 10, db);
    await disk.put(key('one'), blob(), Date.now());
    const cache = new SessionCoverCache(100, 10, disk);
    const load = vi.fn(async () => blob());
    const controller = new AbortController();
    const [a, b] = await Promise.all([
      cache.resolve(key('one'), load, controller.signal),
      cache.resolve(key('one'), load, controller.signal),
    ]);
    expect(a).toBe(b);
    expect(cache.peek(key('one'))).toBe(a);
    expect(load).not.toHaveBeenCalled();
    expect(await new PersistentCoverCache('account-b', 100, 10, db).get(key('one'))).toBeUndefined();
    expect(await disk.get(JSON.stringify(['source', 'new-generation', 'one']))).toBeUndefined();
    controller.abort();
    cache.clear();
    expect(await disk.get(key('one'))).toBeDefined();
  });
  it('evicts least recently used blobs by both bytes and entry count', async () => {
    const disk = new PersistentCoverCache('a', 8, 2, `covers-${crypto.randomUUID()}`);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1000);
      await disk.put(key('a'), blob(), 1000);
      now.mockReturnValue(2000);
      await disk.put(key('b'), blob(), 2000);
      now.mockReturnValue(3000);
      await disk.get(key('a'));
      now.mockReturnValue(4000);
      await disk.put(key('c'), blob(), 4000);
      expect(await disk.get(key('b'))).toBeUndefined();
      expect(await disk.get(key('a'))).toBeDefined();
      expect(await disk.get(key('c'))).toBeDefined();
      now.mockReturnValue(4000 + COVER_RETAIN_MS);
      expect(await disk.get(key('c'))).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
  it('returns stale disk artwork immediately while a failed refresh runs', async () => {
    const disk = new PersistentCoverCache('a', 100, 10, `covers-${crypto.randomUUID()}`);
    await disk.put(key('one'), blob(), Date.now() - 31 * 86400_000);
    const cache = new SessionCoverCache(100, 10, disk);
    const load = vi.fn(async () => {
      throw new Error('offline');
    });
    const signal = new AbortController().signal;
    const url = await cache.resolve(key('one'), load, signal);
    expect(url).toMatch(/^blob:/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.resolve(key('one'), load, signal)).toBe(url);
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
  });
  it('explicit refresh removes only the selected source in the selected scope', async () => {
    const db = `covers-${crypto.randomUUID()}`;
    const a = new PersistentCoverCache('a', 100, 10, db);
    const b = new PersistentCoverCache('b', 100, 10, db);
    await a.put(key('one'), blob(), Date.now());
    await b.put(key('one'), blob(), Date.now());
    await a.invalidateSource('source');
    expect(await a.get(key('one'))).toBeUndefined();
    expect(await b.get(key('one'))).toBeDefined();
  });
});
it('continues in memory when browser storage is denied or full', async () => {
  const cache = new SessionCoverCache(100, 10, {
    get: async () => {
      throw new Error('storage denied');
    },
    put: async () => {
      throw new Error('quota');
    },
    invalidateSource: async () => undefined,
  });
  const load = vi.fn(async () => blob());
  const signal = new AbortController().signal;
  expect(await cache.resolve(key('one'), load, signal)).toMatch(/^blob:/);
  await cache.resolve(key('one'), load, signal);
  expect(load).toHaveBeenCalledTimes(1);
  cache.clear();
});
it('does not publish disk artwork after the owning session is cleared', async () => {
  let finish!: (value: undefined) => void;
  const cache = new SessionCoverCache(100, 10, {
    get: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    put: async () => undefined,
    invalidateSource: async () => undefined,
  });
  const load = vi.fn(async () => blob());
  const pending = cache.resolve(key('one'), load, new AbortController().signal);
  await Promise.resolve();
  cache.clear();
  finish(undefined);
  await expect(pending).rejects.toBeDefined();
  expect(load).not.toHaveBeenCalled();
  expect(cache.peek(key('one'))).toBeUndefined();
});

it('serves stale disk artwork offline without attempting revalidation', async () => {
  const disk = new PersistentCoverCache('a', 100, 10, `covers-${crypto.randomUUID()}`);
  await disk.put(key('offline'), blob(), Date.now() - 60 * 86400_000);
  vi.stubGlobal('navigator', { onLine: false });
  const cache = new SessionCoverCache(100, 10, disk);
  const load = vi.fn(async () => blob());
  expect(await cache.resolve(key('offline'), load, new AbortController().signal)).toMatch(/^blob:/);
  expect(load).not.toHaveBeenCalled();
  cache.clear();
});

it('a hosted quota sweep cannot evict another hosted account', async () => {
  const db = `covers-${crypto.randomUUID()}`;
  const a = new PersistentCoverCache('hosted-account:A', 4, 1, db);
  const b = new PersistentCoverCache('hosted-account:B', 4, 1, db);
  await b.put(key('same'), blob(), Date.now());
  await a.put(key('same'), blob(), Date.now());
  await a.put(key('next'), blob(), Date.now());
  expect(await b.get(key('same'))).toBeDefined();
  await a.invalidateSource('source');
  expect(await b.get(key('same'))).toBeDefined();
});
