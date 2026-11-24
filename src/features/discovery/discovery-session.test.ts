import { storedSourcePage } from '../../external-sources/cached-page';
import type { ExternalCatalogCachePage, ExternalItemPage } from '../../external-sources/contracts';
import 'fake-indexeddb/auto';
import {
  ExternalSourceLocalStateStore,
  clearSourceMetadataCache,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import { DiscoverySession } from './discovery-session';
const context = {} as TrustedExternalSourceHostContext;
function fixture() {
  let generation = 'one';
  const list = vi.fn(async (..._args: unknown[]) => ({ items: [] }));
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: generation }),
    listExternalSource: list,
  } as unknown as ExternalSourceRegistryPort;
  return {
    registry,
    session: new DiscoverySession(registry, context),
    list,
    change: () => {
      generation = 'two';
    },
  };
}
describe('DiscoverySession', () => {
  beforeEach(async () => resetExternalSourceLocalStateForTests());
  afterEach(() => vi.restoreAllMocks());
  it('shares concurrent requests and reuses the page across tabs', async () => {
    const { session, list } = fixture();
    await Promise.all([session.list('a', { browseMode: 'popular' }), session.list('a', { browseMode: 'popular' })]);
    await session.list('a', { browseMode: 'popular' });
    expect(list).toHaveBeenCalledTimes(1);
    await session.list('a', { browseMode: 'latest' });
    expect(list).toHaveBeenCalledTimes(2);
    session.dispose();
  });
  it('does not publish responses from a disconnected generation', async () => {
    const { session, list, change } = fixture();
    let finish!: (value: { items: [] }) => void;
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.list('a', {});
    change();
    finish({ items: [] });
    await expect(pending).rejects.toThrow('변경');
    expect(session.peek('a', {})).toBeUndefined();
    session.dispose();
  });
  it('bounds parallel lists and releases the queue when a source fails', async () => {
    const { session, list } = fixture();
    const finish: Array<() => void> = [];
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(() => resolve({ items: [] }));
        }),
    );
    const requests = ['a', 'b', 'c', 'd'].map((id) => session.list(id, {}));
    expect(list).toHaveBeenCalledTimes(2);
    finish.shift()!();
    await requests[0];
    expect(list).toHaveBeenCalledTimes(3);
    finish.shift()!();
    await requests[1];
    expect(list).toHaveBeenCalledTimes(4);
    finish.forEach((f) => f());
    await Promise.all(requests);
    list.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(session.list('e', {})).rejects.toThrow('unavailable');
    expect(session.peek('a', {})).toBeDefined();
    session.dispose();
  });
  it('restores persisted results after reopening without extending their age or crossing account scopes', async () => {
    const { session, registry, list } = fixture();
    const store = new ExternalSourceLocalStateStore();
    const input = { browseMode: 'popular' as const };
    await session.list('a', input);
    await vi.waitFor(async () => expect(await store.getCachePage(session.key('a', input))).toBeDefined());
    const time = session.peek('a', input)!.time;
    session.dispose();
    const reopened = new DiscoverySession(registry, context);
    await reopened.restore('a', input);
    expect(reopened.peek('a', input)?.time).toBe(time);
    await reopened.list('a', input);
    expect(list).toHaveBeenCalledTimes(1);
    const other = new DiscoverySession(registry, context, 'other-account');
    expect(await other.restore('a', input)).toBeUndefined();
    await reopened.list('a', input, true);
    expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ cacheMode: 'reload' });
    reopened.dispose();
    other.dispose();
  });
});

it('publishes a persisted stale page and its coverRef while a list refresh remains pending', async () => {
  const { session, list } = fixture();
  const input = { browseMode: 'latest' as const };
  const page: ExternalItemPage = {
    items: [
      {
        key: { connectorId: 'a', remoteId: 'work' },
        coverRef: { connectorId: 'a', remoteId: 'work' },
        thumbnailUrl: 'blob:old-document',
        kind: 'work',
        title: 'Sample',
        importability: 'supported',
      },
    ],
    cache: { fetchedAt: Date.now() - 360_000 },
  };
  await new ExternalSourceLocalStateStore().saveCachePage(storedSourcePage(session.key('a', input), 'a', input, page));
  const restored = await session.restore('a', input);
  expect(restored?.items[0].coverRef).toEqual(page.items[0].coverRef);
  expect(restored?.items[0].thumbnailUrl).toBeUndefined();
  expect(restored?.cache?.stale).toBe(true);
  let finish!: (page: { items: [] }) => void;
  list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = session.list('a', input);
  expect(session.peek('a', input)?.page).toBe(restored);
  expect(await session.restore('a', input)).toBe(restored);
  expect(list).toHaveBeenCalledOnce();
  finish({ items: [] });
  expect(await refresh).toEqual(session.peek('a', input)?.page);
  session.dispose();
});

it('shares disk hydration and refuses to replace a newer list response with its late result', async () => {
  const { session } = fixture();
  const input = { browseMode: 'popular' as const };
  let finish!: (page: ExternalCatalogCachePage) => void;
  const get = vi.spyOn(ExternalSourceLocalStateStore.prototype, 'getCachePage').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const first = session.restore('a', input);
    const second = session.restore('a', input);
    expect(get).toHaveBeenCalledOnce();
    const fresh = await session.list('a', input);
    finish(
      storedSourcePage(session.key('a', input), 'a', input, { items: [], cache: { fetchedAt: Date.now() - 60_000 } }),
    );
    expect(await first).toBe(fresh);
    expect(await second).toBe(fresh);
    expect(session.peek('a', input)?.page).toBe(fresh);
  } finally {
    get.mockRestore();
    session.dispose();
  }
});

it('cancels only the departing consumer of a shared list', async () => {
  const { session, list } = fixture();
  let finish!: (page: { items: [] }) => void;
  list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const first = session.list('a', {}, false, abort.signal);
  const second = session.list('a', {});
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await cancelled;
  expect((list.mock.calls[0][3] as AbortSignal).aborted).toBe(false);
  finish({ items: [] });
  await second;
  expect(list).toHaveBeenCalledOnce();
  session.dispose();
});

it('removes abandoned queued searches and retains permits for loaders ignoring abort', async () => {
  const { session, list } = fixture();
  const finish: Array<() => void> = [];
  list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(() => resolve({ items: [] }));
      }),
  );
  const firstAbort = new AbortController();
  const queuedAbort = new AbortController();
  const first = session.list('a', { query: 'old' }, false, firstAbort.signal);
  const other = session.list('b', {});
  const queued = session.list('a', { query: 'discarded' }, false, queuedAbort.signal);
  const next = session.list('a', { query: 'new' });
  const queuedCancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  queuedAbort.abort();
  await queuedCancelled;
  const firstCancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  firstAbort.abort();
  await firstCancelled;
  expect((list.mock.calls[0][3] as AbortSignal).aborted).toBe(true);
  expect(list).toHaveBeenCalledTimes(2);
  finish[0]();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(list.mock.calls[2][2]).toMatchObject({ query: 'new' });
  expect(session.peek('a', { query: 'old' })).toBeUndefined();
  finish[1]();
  finish[2]();
  await Promise.all([other, next]);
  session.dispose();
});

it('keeps a replacement request shared when the abandoned same-key request settles', async () => {
  const { session, list } = fixture();
  const finish: Array<() => void> = [];
  list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(() => resolve({ items: [] }));
      }),
  );
  const abort = new AbortController();
  const first = session.list('a', {}, false, abort.signal);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await cancelled;
  const replacement = session.list('a', {});
  finish[0]();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  const shared = session.list('a', {});
  finish[1]();
  await Promise.all([replacement, shared]);
  expect(list).toHaveBeenCalledTimes(2);
  session.dispose();
});

it('finishes one background refresh when a stale reader leaves and another opens the same list', async () => {
  const { session, list } = fixture();
  const input = { browseMode: 'popular' as const };
  await session.list('a', input);
  // Empty results expire in a minute, independently of the longer popular-list lifetime.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try {
    const caller = new AbortController();
    let finish!: (page: { items: [] }) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stale = session.peek('a', input)!.page;
    const leaving = session.list('a', input, false, caller.signal);
    const cancelled = expect(leaving).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await cancelled;
    expect((list.mock.lastCall![3] as AbortSignal).aborted).toBe(false);
    expect(await session.restore('a', input)).toBe(stale);
    const returning = session.list('a', input);
    finish({ items: [] });
    expect(await returning).toBe(session.peek('a', input)?.page);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
    session.dispose();
  }
});

it('coalesces explicit reloads behind an already running ordinary read', async () => {
  const { session, list } = fixture();
  const finishes: Array<(page: { items: [] }) => void> = [];
  list.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  const ordinary = session.list('a', {});
  const reload = session.list('a', { cacheMode: 'reload' });
  const alsoReload = session.list('a', {}, true);
  expect(list).toHaveBeenCalledTimes(1);
  finishes.shift()!({ items: [] });
  await ordinary;
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(list.mock.lastCall![2]).toMatchObject({ cacheMode: 'reload' });
  finishes.shift()!({ items: [] });
  expect(await reload).toBe(await alsoReload);
  session.dispose();
});

it('clearing this account retires the session before a late list can repopulate disk', async () => {
  const { registry, list } = fixture();
  const scope = 'hosted-account:cache-fixture';
  const session = new DiscoverySession(registry, context, scope);
  const invalidated = vi.fn();
  const release = session.mount(invalidated);
  const storage = new ExternalSourceLocalStateStore(scope);
  const key = session.key('a', {});
  try {
    let finish!: (page: { items: [] }) => void;
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.list('a', {});
    await clearSourceMetadataCache('hosted-account:other');
    expect(invalidated).not.toHaveBeenCalled();
    const done = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await clearSourceMetadataCache(scope);
    finish({ items: [] });
    await done;
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(await storage.getCachePage(key)).toBeUndefined();
    expect(session.peek('a', {})).toBeUndefined();
  } finally {
    release();
  }
});

it('requires a live read before showing a page when list caching is disabled', async () => {
  const { session, list } = fixture();
  const input = { browseMode: 'popular' as const };
  await session.list('a', input);
  expect(session.peek('a', input)).toBeDefined();
  const disabled = { ...input, cacheMaxAgeMs: 0 };
  const disk = vi.spyOn(ExternalSourceLocalStateStore.prototype, 'getCachePage');
  try {
    expect(session.peek('a', disabled)).toBeUndefined();
    expect(await session.restore('a', disabled)).toBeUndefined();
    expect(disk).not.toHaveBeenCalled();
    await session.list('a', disabled);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.lastCall![2]).toMatchObject({ cacheMaxAgeMs: 0 });
    expect(session.peek('a', disabled)).toBeUndefined();
  } finally {
    disk.mockRestore();
    session.dispose();
  }
});
