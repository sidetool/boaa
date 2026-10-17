import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCoverCache } from './session-cover-cache';
import { PersistentCoverCache } from './persistent-cover-cache';
import { sourceReadingDefaults } from './source-reading-preferences';
import { subscribeCoverChanges } from './cover-cache-changes';

const key = JSON.stringify(['sample.source', 'generation', 'work']);
const signal = () => new AbortController().signal;
const image = () => new Blob(['cover'], { type: 'image/png' });
const notFound = () => Object.assign(new Error('missing'), { status: 404 });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('missing source covers', () => {
  it.each(['404', 'undefined', 'empty blob'] as const)('remembers %s until coverHours expires', async (kind) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = new SessionCoverCache();
    const load = vi.fn(async () => {
      if (kind === '404') throw notFound();
      return kind === 'empty blob' ? new Blob([]) : undefined;
    });
    const consumer = signal();
    expect(await cache.resolve(key, load, consumer)).toBeUndefined();
    now += sourceReadingDefaults.coverHours * 3600000 - 1;
    expect(cache.peek(key)).toBeUndefined();
    expect(await cache.resolve(key, load, consumer)).toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    now++;
    load.mockResolvedValue(image());
    expect(await cache.resolve(key, load, consumer)).toMatch(/^blob:/);
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it.each([
    new TypeError('Failed to fetch'),
    Object.assign(new Error('server'), { status: 500 }),
    Object.assign(new Error('gateway'), { statusCode: 503, cause: notFound() }),
    new DOMException('cancelled', 'AbortError'),
    new DOMException('timeout', 'TimeoutError'),
    Object.assign(new Error('authentication'), { status: 403 }),
  ])('does not remember unsuccessful requests: %s', async (error) => {
    const disk = {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => {}),
      putMissing: vi.fn(async () => {}),
      invalidateSource: vi.fn(async () => {}),
    };
    const cache = new SessionCoverCache(undefined, undefined, disk);
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(image());
    await expect(cache.resolve(key, load, signal())).rejects.toBe(error);
    expect(await cache.resolve(key, load, signal())).toMatch(/^blob:/);
    expect(load).toHaveBeenCalledTimes(2);
    expect(disk.putMissing).not.toHaveBeenCalled();
    cache.clear();
  });

  it('restores missing results from disk, isolates accounts and refreshes explicitly', async () => {
    const db = `covers-${crypto.randomUUID()}`;
    const disk = new PersistentCoverCache('account-a', 100, 10, db);
    const cache = new SessionCoverCache(100, 10, disk);
    const load = vi.fn(async (): Promise<Blob | undefined> => {
      throw notFound();
    });
    expect(await cache.resolve(key, load, signal())).toBeUndefined();
    await vi.waitFor(async () => expect(await disk.get(key)).toMatchObject({ missing: true }));
    cache.clear();
    const restored = new SessionCoverCache(100, 10, disk);
    expect(await restored.resolve(key, load, signal())).toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    expect(await new PersistentCoverCache('account-b', 100, 10, db).get(key)).toBeUndefined();
    expect(await disk.get(JSON.stringify(['sample.source', 'other-generation', 'work']))).toBeUndefined();
    restored.invalidateSource('sample.source');
    load.mockResolvedValue(image());
    expect(await restored.resolve(key, load, signal())).toMatch(/^blob:/);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await disk.get(key))?.missing).toBeUndefined());
    restored.clear();
  });

  it('honors disabled negative caching and bounded missing-entry storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ coverHours: 0 }) });
    const cache = new SessionCoverCache();
    const load = vi.fn(async () => undefined);
    await cache.resolve(key, load, signal());
    await cache.resolve(key, load, signal());
    expect(load).toHaveBeenCalledTimes(2);
    cache.clear();
    const disk = new PersistentCoverCache('a', 100, 1, `covers-${crypto.randomUUID()}`);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    await disk.putMissing(key, 1000);
    vi.mocked(Date.now).mockReturnValue(2000);
    const other = JSON.stringify(['sample.source', 'generation', 'other']);
    await disk.putMissing(other, 2000);
    expect(await disk.get(key)).toBeUndefined();
    expect(await disk.get(other)).toMatchObject({ missing: true });
  });

  it.each(['empty', '404'] as const)(
    'does not resurrect %s after refresh invalidates an in-flight request',
    async (kind) => {
      const cache = new SessionCoverCache();
      let finish!: () => void;
      const load = () =>
        new Promise<undefined>((resolve, reject) => {
          finish = () => (kind === 'empty' ? resolve(undefined) : reject(notFound()));
        });
      const pending = cache.resolve(key, load, signal());
      cache.invalidateSource('sample.source');
      finish();
      await expect(pending).rejects.toBeDefined();
      expect(await cache.resolve(key, async () => image(), signal())).toMatch(/^blob:/);
      cache.clear();
    },
  );

  it('publishes a removed cover once and keeps the missing result for the TTL', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = new SessionCoverCache();
    const changed = vi.fn();
    const unsubscribe = subscribeCoverChanges(changed);
    try {
      const url = await cache.resolve(key, async () => image(), signal());
      now += sourceReadingDefaults.coverHours * 3600000;
      const missing = vi.fn(async () => undefined);
      expect(await cache.resolve(key, missing, signal())).toBe(url);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(cache.peek(key)).toBeUndefined();
      expect(await cache.resolve(key, missing, signal())).toBeUndefined();
      expect(missing).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      cache.clear();
    }
  });
});
