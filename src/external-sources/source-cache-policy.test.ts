import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheBudget } from '../../packages/extension-runtime/cache-budget.mjs';
import { InstalledPackageSourceRegistry, type InstalledSourceCatalogPort } from './installed-package-source-registry';
import { ExternalSourceLocalStateStore, resetExternalSourceLocalStateForTests } from './local-state';
import { storedSourcePage, restoredSourcePage } from './cached-page';
import { sourceCachePolicy } from './cache-policy';
const context = { brokers: { get: () => undefined } };
const signal = () => new AbortController().signal;
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanups.splice(0).forEach((clean) => clean());
});
function fixture(owner?: symbol) {
  let generation = 'one',
    fail = false,
    version = 1;
  const source = () => ({
    packageId: 'test',
    generation,
    descriptor: { id: 'source', capabilities: ['search'], seriesProfile: { kind: 'document_series' } },
  });
  const listener = new Set<() => void>();
  const invoke = vi.fn(async (_id, method, input, _signal, options) => {
    if (fail) throw new Error('source_connection_failed');
    if (method === 'source.getWork') return { result: { id: 'work', title: 'Work' }, assets: new Map() };
    return {
      result: {
        items:
          method === 'source.listWorks'
            ? [{ id: `work-${version}`, title: 'Work' }]
            : [{ id: `release-${version}`, title: 'One', order: 1 }],
        nextCursor: input.cursor ? undefined : 'next',
      },
      assets: new Map(),
      options,
    };
  });
  const catalog = {
    getSource: source,
    getSources: () => [source()],
    subscribe: (l: () => void) => {
      listener.add(l);
      return () => listener.delete(l);
    },
    invoke,
  } as unknown as InstalledSourceCatalogPort;
  const registry = new InstalledPackageSourceRegistry(catalog, owner);
  cleanups.push(() => registry.dispose());
  const list = (input = {}) => registry.listExternalSource('source', context, input, signal());
  return {
    list,
    invoke,
    registry,
    fail: () => {
      fail = true;
    },
    update: () => {
      version++;
    },
    generation: () => {
      generation = 'two';
      listener.forEach((l) => l());
    },
    unchanged: () => listener.forEach((l) => l()),
  };
}
describe('source cache policy', () => {
  it('reuses popular and search pages for six hours while checking latest and release lists more often', () => {
    const minute = 60_000,
      day = 24 * 60 * minute;
    for (const input of [{ browseMode: 'popular' as const }, { query: 'word' }, { browseMode: 'search' as const }])
      expect(sourceCachePolicy(input)).toEqual({ fresh: 360 * minute, keep: 7 * day });
    expect(sourceCachePolicy({ parentRef: 'catalog', query: 'word' }).fresh).toBe(360 * minute);
    expect(sourceCachePolicy({ parentRef: 'folder', accountConnectionId: 'drive' }).fresh).toBe(2 * minute);
    expect(sourceCachePolicy({ query: 'file', accountConnectionId: 'drive' }).fresh).toBe(10 * minute);
    expect(sourceCachePolicy({ parentRef: 'catalog', browseMode: 'latest' }).fresh).toBe(5 * minute);
    expect(sourceCachePolicy({ browseMode: 'latest' })).toEqual({ fresh: 5 * minute, keep: 2 * day });
    expect(sourceCachePolicy({ parentRef: 'work' })).toEqual({ fresh: 15 * minute, keep: 7 * day });
    expect(sourceCachePolicy({ query: 'word', cacheMaxAgeMs: 2 * minute }).fresh).toBe(2 * minute);
  });
  it('skips a repeat search after five hours and sees new results at six', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture();
    const input = { query: 'word' };
    await f.list(input);
    f.update();
    now += 5 * 3600_000;
    expect((await f.list(input)).items[0].key.remoteId).toBe('work-1');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    now += 3600_000;
    expect((await f.list(input)).items[0].key.remoteId).toBe('work-2');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('keeps a saved account preference when the device default changes', () => {
    const values = new Map([
      ['boaa.source-reading.v1:hosted-account:a', '{"listMinutes":30}'],
      ['boaa.source-reading.v1:hosted-account:b', '{"listMinutes":0}'],
    ]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null });
    for (const [account, minutes] of [
      ['a', 30],
      ['b', 0],
      ['c', 360],
    ] as const)
      expect(sourceCachePolicy({ query: 'one' }, false, 'hosted-account:' + account).fresh).toBe(minutes * 60_000);
  });
  it('checks an empty page after a minute and preserves that expiry on disk', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture();
    f.invoke.mockResolvedValueOnce({
      result: { items: [], nextCursor: undefined },
      assets: new Map(),
      options: undefined,
    });
    const input = { query: 'new work' };
    const empty = await f.list(input);
    const disk = storedSourcePage('empty', 'source', input, empty);
    expect(Date.parse(disk.expiresAt) - now).toBe(60_000);
    now += 59_999;
    expect((await f.list(input)).items).toEqual([]);
    now += 1;
    expect((await f.list(input)).items).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('changing freshness does not invalidate cursors and zero forces revalidation', async () => {
    const f = fixture();
    const first = await f.list();
    await f.list({ cacheMaxAgeMs: 0 });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    const second = await f.list({ cacheMaxAgeMs: 120000 });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    await f.list({ cursor: second.nextCursor, cacheMaxAgeMs: 0 });
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(first.items).toEqual(second.items);
  });
  it('reuses normal lists, preserves original age and forces both detail and releases on refresh', async () => {
    const f = fixture();
    const a = await f.list();
    f.unchanged();
    expect((await f.list()).cache?.fetchedAt).toBe(a.cache?.fetchedAt);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.update();
    expect((await f.list({ cacheMode: 'reload' })).items[0]?.key.remoteId).toBe('work-2');
    await f.list({ parentRef: 'work' });
    const before = f.invoke.mock.calls.length;
    await f.list({ parentRef: 'work' });
    expect(f.invoke).toHaveBeenCalledTimes(before);
    await f.list({ parentRef: 'work', cacheMode: 'reload' });
    expect(f.invoke.mock.calls.slice(-2).map((call) => call[4])).toMatchObject([
      { cacheMode: 'reload' },
      { cacheMode: 'reload' },
    ]);
  });
  it('does not append an old cursor after refreshing or changing source/query generation', async () => {
    const f = fixture();
    const a = await f.list();
    expect((await f.list({ cursor: a.nextCursor })).items).toHaveLength(1);
    await expect(f.list({ cursor: a.nextCursor, query: 'other' })).rejects.toThrow('source_catalog_changed');
    await f.list({ cacheMode: 'reload' });
    await expect(f.list({ cursor: a.nextCursor })).rejects.toThrow('source_catalog_changed');
    f.generation();
    await f.list();
    expect(f.invoke.mock.calls.filter((call) => call[1] === 'source.listWorks')).toHaveLength(4);
  });
  it('retains a stale successful list on transient failure without extending its age; manual refresh reports failure', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture(),
      a = await f.list({ browseMode: 'latest' });
    now += 5 * 60_000 + 1;
    f.fail();
    const b = await f.list({ browseMode: 'latest' });
    expect(b.cache).toEqual({ fetchedAt: a.cache!.fetchedAt, stale: true });
    await expect(f.list({ browseMode: 'latest', cacheMode: 'reload' })).rejects.toThrow('connection_failed');
    now += 2 * 86400_000;
    await expect(f.list({ browseMode: 'latest' })).rejects.toThrow('connection_failed');
  });
  it('evicts a successful page when a forced refresh reports a revoked permission', async () => {
    const f = fixture();
    const input = { browseMode: 'popular' as const };
    await f.list(input);
    f.invoke.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await expect(f.list({ ...input, cacheMode: 'reload' })).rejects.toThrow('Forbidden');
    f.update();
    expect((await f.list(input)).items[0].key.remoteId).toBe('work-2');
    expect(f.invoke).toHaveBeenCalledTimes(3);
  });
  it('isolates account caches and applies global as well as owner byte limits', async () => {
    const a = fixture(),
      b = fixture();
    await a.list();
    await b.list();
    expect(b.invoke).toHaveBeenCalledTimes(1);
    const pool = new CacheBudget<string>(12, 10, 8, 10),
      one = Symbol(),
      two = Symbol();
    pool.set(one, 'a', 'a', 4, Date.now() + 1000);
    pool.set(one, 'b', 'b', 4, Date.now() + 1000);
    pool.set(one, 'c', 'c', 4, Date.now() + 1000);
    expect(pool.get(one, 'a')).toBeUndefined();
    pool.set(two, 'd', 'd', 8, Date.now() + 1000);
    expect(pool.get(one, 'b')).toBeUndefined();
    expect(pool.get(one, 'c')).toBe('c');
    expect(pool.get(two, 'c')).toBeUndefined();
  });
  it('persists only within the retention/byte budgets and never touches library links', async () => {
    await resetExternalSourceLocalStateForTests();
    const store = new ExternalSourceLocalStateStore();
    const page = storedSourcePage('cache', 'source', { browseMode: 'latest' }, { items: [] }, 'owner');
    await store.saveCachePage(page);
    expect((await store.getCachePage('cache'))?.items).toEqual([]);
    await store.saveCachePage({
      ...page,
      id: 'expired',
      fetchedAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
      retainUntil: new Date(Date.now() - 1).toISOString(),
    });
    expect(await store.getCachePage('expired')).toBeUndefined();
    await store.saveCachePage({ ...page, id: 'large', queryFingerprint: 'x'.repeat(33 * 1024 * 1024) });
    expect(await store.getCachePage('large')).toBeUndefined();
    expect(await store.getCachePage('cache')).toBeDefined();
    const transientCover = storedSourcePage(
      'cover',
      'source',
      {},
      { items: [], detail: { title: 'Work', thumbnailUrl: 'blob:previous-document' } },
    );
    expect(transientCover.detail?.thumbnailUrl).toBeUndefined();
    expect(restoredSourcePage(transientCover).cache?.stale).toBe(true);
    const publicCover = storedSourcePage(
      'cover',
      'source',
      {},
      { items: [], detail: { title: 'Work', thumbnailUrl: 'https://example.org/cover.jpg' } },
    );
    expect(publicCover.detail?.thumbnailUrl).toBe('https://example.org/cover.jpg');
  });
});
