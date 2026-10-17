import { expect, it, vi } from 'vitest';
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
