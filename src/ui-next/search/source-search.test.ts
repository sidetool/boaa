import { expect, it, vi } from 'vitest';
import { sourceCachePolicy } from '../../external-sources/cache-policy';
import { DiscoverySession } from '../../features/discovery/discovery-session';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type {
  ExternalItemPage,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import { SourceSearch } from './source-search';
import { AppExternalSourceRegistry } from '../../external-sources/app-external-source-registry';
import { compositeSourceRegistry } from '../../external-sources/composite-source-registry';

export function searchFixture() {
  const pending: {
    source: string;
    input: ExternalSourceListInput;
    signal: AbortSignal;
    resolve(page: ExternalItemPage): void;
    reject(error: Error): void;
  }[] = [];
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected', accountConnectionId: 'account' }),
    getExternalSources: () => [
      { descriptor: { id: 'fixture.first', capabilities: ['search'] } },
      { descriptor: { id: 'fixture.second', capabilities: ['search'] } },
    ],
    listExternalSource: vi.fn(
      (source: string, _context: unknown, input: ExternalSourceListInput, signal: AbortSignal) =>
        new Promise<ExternalItemPage>((resolve, reject) => pending.push({ source, input, signal, resolve, reject })),
    ),
  } as unknown as ExternalSourceRegistryPort;
  const session = new DiscoverySession(registry, {} as TrustedExternalSourceHostContext, 'search-test');
  const sources = [
    { id: 'fixture.first', title: 'First' },
    { id: 'fixture.second', title: 'Second' },
  ];
  return { registry, session, sources, pending };
}
const page = (title: string): ExternalItemPage => ({
  items: [{ key: { connectorId: 'fixture.first', remoteId: title }, kind: 'work', title, importability: 'supported' }],
});

it('forwards optional child targets through both registry layers and rejects a changed account', async () => {
  const f = searchFixture();
  const target = { id: 'child', title: 'Child', parentRef: 'opaque' };
  f.registry.getExternalSourceSearchTargets = vi.fn(async () => [target]);
  const registry = new AppExternalSourceRegistry([], compositeSourceRegistry(f.registry));
  const signal = new AbortController().signal;
  expect(await registry.getExternalSourceSearchTargets('fixture.first', f.session.context, signal)).toEqual([target]);
  f.registry.getExternalSourceSearchTargets = vi.fn(async () => {
    f.registry.getExternalSourceStatus = () => ({ state: 'connected', accountConnectionId: 'changed' });
    return [target];
  });
  await expect(registry.getExternalSourceSearchTargets('fixture.first', f.session.context, signal)).rejects.toThrow();
  f.session.dispose();
});

it('starts all sources together, publishes out of order, and retries a failed source alone', async () => {
  const f = searchFixture();
  const store = new SourceSearch(f.session, f.sources);
  expect(store.getSnapshot().answers.map((answer) => answer.status)).toEqual(['idle', 'idle']);
  store.submit('term');
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  expect(f.pending.map((request) => request.input)).toEqual(
    f.sources.map(() => ({
      browseMode: 'search',
      query: 'term',
      parentRef: undefined,
      accountConnectionId: 'account',
    })),
  );
  f.pending[1].resolve(page('fast'));
  await vi.waitFor(() =>
    expect(store.getSnapshot().answers.map((answer) => answer.status)).toEqual(['loading', 'ready']),
  );
  f.pending[0].reject(new Error('offline'));
  await vi.waitFor(() => expect(store.getSnapshot().answers[0].error).toBe('offline'));
  store.retry(store.getSnapshot().answers[0]);
  expect(store.getSnapshot().answers[0].status).toBe('loading');
  await vi.waitFor(() => expect(f.pending).toHaveLength(3));
  expect(f.pending[2].source).toBe('fixture.first');
  expect(store.getSnapshot().answers[1].page?.items[0].title).toBe('fast');
  f.pending[2].resolve(page('retry'));
  await vi.waitFor(() => expect(store.getSnapshot().answers[0].status).toBe('ready'));
  store.cancel();
  f.session.dispose();
});

it('aborts previous searches and ignores late results even from providers ignoring abort', async () => {
  const f = searchFixture();
  const store = new SourceSearch(f.session, f.sources);
  store.submit('old');
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  store.submit('new');
  expect(f.pending.every((request) => request.signal.aborted)).toBe(true);
  await vi.waitFor(() => expect(f.pending).toHaveLength(4));
  f.pending[0].resolve(page('wrong'));
  f.pending[1].reject(new Error('old failure'));
  f.pending[2].resolve(page('new'));
  await vi.waitFor(() => expect(store.getSnapshot().answers[0].status).toBe('ready'));
  expect(store.getSnapshot().submitted).toBe('new');
  expect(store.getSnapshot().answers[0].page?.items[0].title).toBe('new');
  store.cancel();
  expect(f.pending[3].signal.aborted).toBe(true);
  f.pending[3].resolve(page('after cancel'));
  await Promise.resolve();
  expect(store.getSnapshot().answers[1].status).toBe('idle');
  store.submit('');
  expect(store.getSnapshot().answers.every((answer) => !answer.page && answer.status === 'idle')).toBe(true);
  f.session.dispose();
});

it('searches enumerated child catalogs in parallel without calling the combined root search', async () => {
  const f = searchFixture();
  f.registry.getExternalSourceSearchTargets = vi.fn(async (id) =>
    id === 'fixture.first'
      ? [
          { id: 'a', title: 'A', parentRef: 'opaque-a' },
          { id: 'b', title: 'B', parentRef: 'opaque-b' },
        ]
      : undefined,
  );
  const store = new SourceSearch(f.session, f.sources);
  store.submit('nested');
  await vi.waitFor(() => expect(f.pending).toHaveLength(3));
  expect(
    f.pending.filter((request) => request.source === 'fixture.first').map((request) => request.input.parentRef),
  ).toEqual(['opaque-a', 'opaque-b']);
  expect(store.getSnapshot().answers.map((answer) => answer.title)).toEqual(['A', 'B', 'Second']);
  f.pending[1].resolve(page('B first'));
  await vi.waitFor(() => expect(store.getSnapshot().answers[1].status).toBe('ready'));
  expect(store.getSnapshot().answers[0].status).toBe('loading');
  store.cancel();
  f.session.dispose();
});

it('reuses fresh searches across routes, renders retained pages during refresh, and bypasses them on retry', async () => {
  const f = searchFixture();
  const clock = vi.spyOn(Date, 'now');
  let now = Date.now();
  clock.mockImplementation(() => now);
  const store = () => new SourceSearch(f.session, [f.sources[0]]);
  try {
    const first = store();
    first.submit('term');
    const snapshot = first.getSnapshot();
    expect(first.submit('term')).toBe(false);
    expect(first.getSnapshot()).toBe(snapshot);
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve(page('old'));
    await vi.waitFor(() => expect(first.getSnapshot().answers[0].status).toBe('ready'));

    const second = store();
    second.submit('term');
    expect(second.getSnapshot().answers[0].page?.items[0].title).toBe('old');
    second.retry(second.getSnapshot().answers[0]);
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    expect(f.pending[1].input.cacheMode).toBe('reload');
    f.pending[1].resolve(page('updated'));
    await vi.waitFor(() => expect(second.getSnapshot().answers[0].page?.items[0].title).toBe('updated'));
    expect(second.submit('term')).toBe(false);
    now += 61_000;
    expect(second.submit('term')).toBe(false);
    const policy = sourceCachePolicy({ browseMode: 'search', query: 'term' });
    now += policy.fresh;
    second.submit('term');
    expect(second.getSnapshot().answers[0]).toMatchObject({
      status: 'loading',
      page: { items: [{ title: 'updated' }] },
    });
    await vi.waitFor(() => expect(f.pending).toHaveLength(3));
    f.pending[2].resolve(page('newest'));
    await vi.waitFor(() => expect(second.getSnapshot().answers[0].status).toBe('ready'));

    f.registry.getExternalSourceStatus = () => ({ state: 'connected', accountConnectionId: 'other' });
    second.submit('term');
    expect(second.getSnapshot().answers[0].page).toBeUndefined();
    await vi.waitFor(() => expect(f.pending).toHaveLength(4));
    expect(f.pending[3].input.accountConnectionId).toBe('other');
    second.cancel();
    f.registry.getExternalSourceStatus = () => ({ state: 'connected', accountConnectionId: 'account' });
    const changed = new SourceSearch(f.session, [...f.sources]);
    changed.submit('term');
    expect(changed.getSnapshot().answers.every((answer) => !answer.page)).toBe(true);
    changed.cancel();
  } finally {
    clock.mockRestore();
    f.session.dispose();
  }
});

it('retains results during a transient failure, evicts denials, and never resets the provider data age', async () => {
  const f = searchFixture();
  const store = () => new SourceSearch(f.session, [f.sources[0]]);
  const { fresh, keep } = sourceCachePolicy({ browseMode: 'search', query: 'age' });
  const clock = vi.spyOn(Date, 'now');
  const base = Date.now();
  let now = base;
  clock.mockImplementation(() => now);
  try {
    const a = store();
    a.submit('age');
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));
    f.pending[0].resolve({ ...page('saved'), cache: { fetchedAt: base - fresh - 1 } });
    await vi.waitFor(() => expect(a.getSnapshot().answers[0].status).toBe('ready'));
    const b = store();
    b.submit('age');
    expect(b.getSnapshot().answers[0].page?.items[0].title).toBe('saved');
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    f.pending[1].reject(new Error('network offline'));
    await vi.waitFor(() => expect(b.getSnapshot().answers[0].status).toBe('failed'));
    expect(b.getSnapshot().answers[0].page?.items[0].title).toBe('saved');
    b.retry(b.getSnapshot().answers[0]);
    await vi.waitFor(() => expect(f.pending).toHaveLength(3));
    f.pending[2].reject(Object.assign(new Error('forbidden'), { status: 403 }));
    await vi.waitFor(() => expect(b.getSnapshot().answers[0].status).toBe('failed'));
    expect(b.getSnapshot().answers[0].page).toBeUndefined();
    const c = store();
    c.submit('age');
    expect(c.getSnapshot().answers[0].page).toBeUndefined();
    await vi.waitFor(() => expect(f.pending).toHaveLength(4));
    f.pending[3].resolve({ ...page('expired'), cache: { fetchedAt: base - keep + 1 } });
    await vi.waitFor(() => expect(c.getSnapshot().answers[0].status).toBe('ready'));
    now += 2;
    const d = store();
    d.submit('age');
    expect(d.getSnapshot().answers[0].page).toBeUndefined();
    d.cancel();
  } finally {
    clock.mockRestore();
    f.session.dispose();
  }
});

it('skips oversized results, supports clearing a recent query, and respects the account list reuse setting', async () => {
  const f = searchFixture();
  const session = new DiscoverySession(f.registry, f.session.context, 'hosted-account:reader');
  const store = () => new SourceSearch(session, [f.sources[0]]);
  let minutes = 30;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key.endsWith(':hosted-account:reader') ? JSON.stringify({ listMinutes: minutes }) : null,
  });
  const fetchPage = async (query: string, title: string) => {
    const a = store();
    const index = f.pending.length;
    a.submit(query);
    await vi.waitFor(() => expect(f.pending).toHaveLength(index + 1));
    f.pending[index].resolve(page(title));
    await vi.waitFor(() => expect(a.getSnapshot().answers[0].status).toBe('ready'));
    return a;
  };
  try {
    await fetchPage('large', 'x'.repeat(4 * 1024 * 1024));
    const retry = store();
    retry.submit('large');
    expect(retry.getSnapshot().answers[0].page).toBeUndefined();
    retry.cancel();
    const a = await fetchPage('history', 'saved');
    a.forget(' HISTORY ');
    const cleared = store();
    cleared.submit('history');
    expect(cleared.getSnapshot().answers[0].page).toBeUndefined();
    cleared.cancel();
    await fetchPage('policy', 'saved');
    minutes = 0;
    const disabled = store();
    disabled.submit('policy');
    expect(disabled.getSnapshot().answers[0].page).toBeUndefined();
    disabled.cancel();
  } finally {
    vi.unstubAllGlobals();
    session.dispose();
    f.session.dispose();
  }
});

it('rechecks an empty child catalog after a minute while leaving its populated sibling immediately available', async () => {
  const f = searchFixture();
  f.registry.getExternalSourceSearchTargets = vi.fn(async () => [
    { id: 'a', title: 'A', parentRef: 'a' },
    { id: 'b', title: 'B', parentRef: 'b' },
  ]);
  const clock = vi.spyOn(Date, 'now');
  let now = Date.now();
  clock.mockImplementation(() => now);
  const store = () => new SourceSearch(f.session, [f.sources[0]]);
  try {
    const first = store();
    first.submit('term');
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    f.pending[0].resolve({ items: [] });
    f.pending[1].resolve(page('kept'));
    await vi.waitFor(() => expect(first.getSnapshot().answers.every((a) => a.status === 'ready')).toBe(true));
    now += 61000;
    const again = store();
    again.submit('term');
    expect(again.getSnapshot().answers.map((a) => a.status)).toEqual(['loading', 'ready']);
    await vi.waitFor(() => expect(f.pending).toHaveLength(3));
    expect(f.pending[2].input.parentRef).toBe('a');
    f.pending[2].resolve(page('first work'));
    await vi.waitFor(() => expect(again.getSnapshot().answers[0].page?.items[0].title).toBe('first work'));
    expect(again.getSnapshot().answers[1].page?.items[0].title).toBe('kept');
  } finally {
    clock.mockRestore();
    f.session.dispose();
  }
});

it('evicts the least recently viewed result when retained pages together exceed the byte limit', async () => {
  const f = searchFixture();
  const store = () => new SourceSearch(f.session, [f.sources[0]]);
  const large = 'x'.repeat(900_000); // The fixture includes the value in both its title and remote ID.
  vi.mocked(f.registry.listExternalSource).mockImplementation(async (_id, _ctx, input) => page(input.query + large));
  try {
    for (const query of ['a', 'b']) {
      const active = store();
      active.submit(query);
      await vi.waitFor(() => expect(active.getSnapshot().answers[0].status).toBe('ready'));
    }
    store().submit('a');
    expect(f.registry.listExternalSource).toHaveBeenCalledTimes(2);
    const latest = store();
    latest.submit('c');
    await vi.waitFor(() => expect(latest.getSnapshot().answers[0].status).toBe('ready'));
    const retained = store();
    retained.submit('a');
    expect(retained.getSnapshot().answers[0].status).toBe('ready');
    const evicted = store();
    evicted.submit('b');
    expect(evicted.getSnapshot().answers[0].page).toBeUndefined();
    evicted.cancel();
  } finally {
    f.session.dispose();
  }
});
