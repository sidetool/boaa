import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExternalItemPage } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { DiscoverySession } from './discovery-session';
import { useDiscoverySection } from './useDiscoverySection';
import { useDiscoveryPages } from './useDiscoveryPages';

vi.mock('./useDiscoveryCover', () => ({ useNear: () => true }));
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
const section = { id: 'swr', sourceId: 'sample.source', mode: 'popular' as const, title: '', filterSignature: '[]' };
const source = { id: section.sourceId, kind: 'catalog', connection: { state: 'connected' } } as ExternalSourceView;
const page = (id: string): ExternalItemPage => ({
  items: [
    {
      key: { connectorId: section.sourceId, remoteId: id },
      coverRef: { connectorId: section.sourceId, remoteId: id },
      title: id,
      kind: 'work',
      importability: 'supported',
    },
  ],
  browse: { availableModes: ['popular'], activeMode: 'popular', filters: [] },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(memory = false) {
  const cached = page('cached');
  const schema = deferred<ExternalItemPage>();
  const network = deferred<ExternalItemPage>();
  const session = {
    scope: 'swr',
    key: () => 'swr',
    registry: { getExternalSources: () => [] },
    peek: () => (memory ? { page: cached } : undefined),
    restore: vi.fn(async () => cached),
    schema: vi.fn(() => schema.promise),
    list: vi.fn(() => network.promise),
  } as unknown as DiscoverySession;
  return { cached, schema, network, session };
}
it('shows persisted rail items before schema/list POST resolves and retains them on revalidation failure', async () => {
  const h = fixture();
  let state!: ReturnType<typeof useDiscoverySection>;
  function Probe() {
    state = useDiscoverySection({ section, source, session: h.session, query: '', refresh: 0, positions: new Map() });
    return null;
  }
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(state.page).toEqual(h.cached);
  expect(state.loading).toBe(true);
  expect(h.session.list).not.toHaveBeenCalled();
  await act(async () => h.schema.resolve(page('schema')));
  expect(state.page).toEqual(h.cached);
  await act(async () => h.network.reject(new Error('offline')));
  expect(state.page).toEqual(h.cached);
  expect(state.error).toBe('offline');
});
it('shows a memory rail on its first render and offers changed rows through the existing candidate contract', async () => {
  const h = fixture(true);
  const frames: Array<ExternalItemPage | undefined> = [];
  let state!: ReturnType<typeof useDiscoverySection>;
  function Probe() {
    state = useDiscoverySection({ section, source, session: h.session, query: '', refresh: 0, positions: new Map() });
    frames.push(state.page);
    return null;
  }
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(frames[0]).toEqual(h.cached);
  await act(async () => {
    h.schema.resolve(page('schema'));
    h.network.resolve(page('new'));
  });
  expect(state.page).toEqual(h.cached);
  expect(state.candidate).toEqual(page('new'));
});
it('shows dedicated-list disk items before schema revalidation without changing the shared pages hook', async () => {
  const h = fixture();
  let state!: ReturnType<typeof useDiscoveryPages>;
  function Probe() {
    state = useDiscoveryPages(h.session, section.sourceId, { browseMode: 'popular' }, 0, true, '[]');
    return null;
  }
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(state.items).toEqual(h.cached.items);
  expect(state.busy).toBe(true);
  expect(h.session.list).not.toHaveBeenCalled();
  await act(async () => {
    h.schema.resolve(page('schema'));
    h.network.resolve(page('new'));
  });
  expect(state.items).toEqual(page('new').items);
});
