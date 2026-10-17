import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { DiscoverySession } from './discovery-session';
import { useDiscoveryScreenState, type DiscoveryScreenProps } from './useDiscoveryScreenState';
import { useDiscoverySection } from './useDiscoverySection';
import { useDiscoverySourceView } from './useDiscoverySourceView';

vi.mock('./useDiscoveryCover', () => ({ useNear: () => true }));
const pages = vi.hoisted(() => ({
  items: [],
  busy: false,
  hasPage: true,
  error: '',
  more: false,
  retry: vi.fn(),
  loadMore: vi.fn(),
  browse: { availableModes: ['popular', 'latest', 'search'], filters: [] },
}));
vi.mock('./useDiscoveryPages', () => ({ useDiscoveryPages: () => pages }));
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
const item = (id: string): ExternalItemSummary => ({
  key: { connectorId: 'example.source', remoteId: id },
  title: id,
  kind: 'work',
  importability: 'supported',
});
const source = {
  id: 'example.source',
  title: '테스트 소스',
  kind: 'catalog',
  origin: 'plugin',
  connection: { state: 'connected' },
} as ExternalSourceView;
const section = { id: 'section', sourceId: 'example.source', title: '', mode: 'popular' as const };

it('exposes search, quick navigation, refresh and pin failure commands without screen markup', async () => {
  const save = vi.fn().mockRejectedValue(new Error('save failed'));
  const props = {
    library: {},
    open: vi.fn(),
    discovery: {
      scope: 'headless',
      config: { version: 1, tabs: [{ id: 'tab', title: '탭', sections: [section, { ...section, id: 'other' }] }] },
      save,
      session: { railPositions: new Map(), scrollPositions: new Map() },
    },
    sources: { sources: [source], libraryWorks: [{ connectorId: 'example.source', collectionRemoteId: 'owned' }] },
  } as unknown as DiscoveryScreenProps;
  let state!: ReturnType<typeof useDiscoveryScreenState>;
  function Harness() {
    state = useDiscoveryScreenState(props);
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  expect(state.rows).toHaveLength(2);
  act(() => state.setDraftQuery('  query  '));
  act(() => state.submitSearch());
  expect(state.query).toBe('query');
  expect(state.rows.map((row) => row.id)).toEqual(['search:example.source']);
  expect(state.owned(item('owned'))).toBe(true);
  await act(async () => {
    await state.openQuick('example.source', {});
  });
  expect(state.dedicated?.sourceId).toBe('example.source');
  act(() => {
    state.selectTab('tab');
    state.resetSearch();
    state.refreshSections();
  });
  expect(state.quickSource).toBeUndefined();
  expect(state.query).toBe('');
  expect(state.refresh).toBe(1);
  await act(async () => {
    await state.togglePin(source);
  });
  expect(state.pinError).toBe('save failed');
  await act(async () => {
    await state.openQuick('files', { parentRef: 'folder' });
  });
  expect(props.open).toHaveBeenCalledWith('files', { parentRef: 'folder' });
});

it('preserves cached rail items until the refresh action accepts the candidate, then retries explicitly', async () => {
  const cached = { items: [item('cached')] };
  const updated = { items: [item('updated')] };
  const list = vi.fn().mockResolvedValue(updated);
  const session = {
    scope: 'headless-section',
    registry: { getExternalSources: () => [] },
    peek: () => ({ page: cached }),
    restore: async () => cached,
    list,
  } as unknown as DiscoverySession;
  let state!: ReturnType<typeof useDiscoverySection>;
  const positions = new Map<string, number>();
  function Harness() {
    state = useDiscoverySection({ section, source, session, query: '', refresh: 0, positions });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(state.page).toEqual(cached);
  expect(state.candidate).toEqual(updated);
  act(() => state.refreshSection?.());
  expect(state.page).toEqual(updated);
  expect(state.candidate).toBeUndefined();
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => state.refreshSection?.());
  expect(list).toHaveBeenLastCalledWith('example.source', state.input, true);
  expect(state.itemOpenArgs({ ...item('work'), navigationRef: 'detail' })).toEqual([
    'example.source',
    { parentRef: 'detail' },
    'work',
  ]);
});

it('exposes source search/mode/filter state and pagination commands without screen markup', () => {
  const session = { key: () => 'headless-source' } as unknown as DiscoverySession;
  let state!: ReturnType<typeof useDiscoverySourceView>;
  function Harness() {
    state = useDiscoverySourceView({ section, source, session, refresh: 0 });
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  act(() => state.setDraftQuery('  title  '));
  act(() => state.apply());
  expect(state.input).toMatchObject({ browseMode: 'search', query: 'title', filters: [] });
  act(() => state.changeMode('latest'));
  expect(state.input).toEqual({ parentRef: undefined, browseMode: 'latest' });
  expect(state.draftQuery).toBe('');
  act(() => state.resetSearch());
  expect(state.input.browseMode).toBe('popular');
  expect(state.data.loadMore).toBe(pages.loadMore);
  expect(state.itemOpenArgs(item('work'))).toEqual(['example.source', state.input, undefined]);
});
