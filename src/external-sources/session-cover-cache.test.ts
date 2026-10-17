import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCoverCache } from './session-cover-cache';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('SessionCoverCache', () => {
  it('keeps a shared download alive when one consumer leaves and reuses its URL', async () => {
    const create = vi.fn(() => 'blob:cover');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    let finish!: (blob: Blob) => void;
    const load = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    const cache = new SessionCoverCache();
    const first = new AbortController();
    const a = cache.resolve('one', load, first.signal);
    const b = cache.resolve('one', load, new AbortController().signal);
    first.abort();
    await expect(a).rejects.toBeDefined();
    finish(new Blob(['image'], { type: 'image/png' }));
    expect(await b).toBe('blob:cover');
    expect(await cache.resolve('one', load, new AbortController().signal)).toBe('blob:cover');
    expect(load).toHaveBeenCalledTimes(1);
    cache.clear();
    expect(revoke).toHaveBeenCalledWith('blob:cover');
  });
  it('does not revoke displayed images when the cache reaches its entry limit', async () => {
    let id = 0;
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke });
    const cache = new SessionCoverCache(64 * 1024 * 1024, 200);
    const load = async () => new Blob(['image'], { type: 'image/png' });
    const signal = new AbortController().signal;
    const first = await cache.resolve('0', load, signal);
    vi.stubGlobal('document', { images: [{ src: first }] });
    for (let i = 1; i <= 200; i++) {
      const consumer = new AbortController();
      await cache.resolve(String(i), load, consumer.signal);
      consumer.abort();
    }
    expect(revoke).not.toHaveBeenCalledWith(first);
    expect(revoke).toHaveBeenCalledWith('blob:2');
    cache.clear();
  });
  it('protects concurrent delivery before DOM mounting, then evicts released consumers', async () => {
    let id = 0;
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke });
    vi.stubGlobal('document', { images: [] });
    const cache = new SessionCoverCache(8, 400);
    const consumers = Array.from({ length: 4 }, () => new AbortController());
    const load = async () => new Blob(['1234'], { type: 'image/jpeg' });
    const urls = await Promise.all(consumers.map((consumer, i) => cache.resolve(String(i), load, consumer.signal)));
    expect(revoke).not.toHaveBeenCalled();
    consumers[0].abort();
    consumers[1].abort();
    await cache.resolve('extra', load, consumers[2].signal);
    expect(revoke).toHaveBeenCalledWith(urls[0]);
    expect(revoke).toHaveBeenCalledWith(urls[1]);
    expect(revoke).not.toHaveBeenCalledWith(urls[2]);
    expect(revoke).not.toHaveBeenCalledWith(urls[3]);
    cache.clear();
  });
  it('rejects stale in-flight data after clear without publishing an object URL', async () => {
    const create = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
    const cache = new SessionCoverCache();
    let finish!: (blob: Blob) => void;
    const pending = cache.resolve(
      'one',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      new AbortController().signal,
    );
    cache.clear();
    finish(new Blob(['image'], { type: 'image/png' }));
    await expect(pending).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
  it('shows an expired cover immediately, replaces it after loading, and explicit refresh cancels old fills', async () => {
    let now = Date.now(),
      id = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke });
    const cache = new SessionCoverCache(),
      signal = new AbortController().signal;
    const key = JSON.stringify(['source', 'one', 'work']);
    const image = () => new Blob(['image'], { type: 'image/png' });
    expect(await cache.resolve(key, async () => image(), signal)).toBe('blob:1');
    vi.stubGlobal('document', { images: [{ src: 'blob:1' }] });
    now += 30 * 86400_000 + 1;
    let finish!: (blob: Blob) => void;
    const delayed = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve;
        }),
    );
    expect(await cache.resolve(key, delayed, signal)).toBe('blob:1');
    finish(new Blob(['changed'], { type: 'image/png' }));
    await vi.waitFor(() => expect(id).toBe(2));
    expect(await cache.resolve(key, delayed, signal)).toBe('blob:2');
    expect(revoke).not.toHaveBeenCalledWith('blob:1');
    cache.invalidateSource('source');
    const pending = cache.resolve(key, delayed, signal);
    cache.invalidateSource('source');
    finish(image());
    await expect(pending).rejects.toBeDefined();
    expect(await cache.resolve(key, async () => image(), signal)).toBe('blob:3');
    cache.clear();
  });
});

it('keeps the URL for identical revalidation bytes and notifies only an actual replacement', async () => {
  const { subscribeCoverChanges } = await import('./cover-cache-changes');
  const changed = vi.fn();
  const unsubscribe = subscribeCoverChanges(changed);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const storage = {
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    invalidateSource: vi.fn(async () => {}),
  };
  const cache = new SessionCoverCache(undefined, undefined, storage);
  const key = JSON.stringify(['sample.source', 'generation', 'work']);
  const image = (body: string) => new Blob([body], { type: 'image/png' });
  const signal = new AbortController().signal;
  try {
    const first = await cache.resolve(key, async () => image('old'), signal);
    now += 30 * 86400_000;
    const unchanged = vi.fn(async () => image('old'));
    expect(await cache.resolve(key, unchanged, signal)).toBe(first);
    await vi.waitFor(() => expect(unchanged).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(storage.put).toHaveBeenCalledTimes(2));
    expect(cache.peek(key)).toBe(first);
    expect(changed).not.toHaveBeenCalled();
    now += 30 * 86400_000;
    expect(await cache.resolve(key, async () => image('new'), signal)).toBe(first);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(cache.peek(key)).not.toBe(first);
  } finally {
    unsubscribe();
    cache.clear();
  }
});
