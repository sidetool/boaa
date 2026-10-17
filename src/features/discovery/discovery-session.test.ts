import { storedSourcePage } from '../../external-sources/cached-page';
import type { ExternalCatalogCachePage, ExternalItemPage } from '../../external-sources/contracts';
import 'fake-indexeddb/auto';
import {
  ExternalSourceLocalStateStore,
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
    cache: { fetchedAt: Date.now() - 180_000 },
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
