import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '@boaa/reader-core/settings';
import type { ReaderSettings } from '../../domain/types';
import { DiscoverySession } from '../../features/discovery/discovery-session';
import { useDiscoveryScreenState } from '../../features/discovery/useDiscoveryScreenState';
import { useDiscoverySourceView } from '../../features/discovery/useDiscoverySourceView';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type {
  ExternalItemPage,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import { actions, model, novel } from '../test-fixtures';
import { useSearchAdapter } from './use-search-adapter';
import type { SearchData } from './data';
import { getSearchRoute, openSearch, setSearchRoute } from './route';

afterEach(() => {
  setSearchRoute(undefined);
  vi.unstubAllGlobals();
});
function fixture() {
  const pending: { input: ExternalSourceListInput; signal: AbortSignal; resolve(page: ExternalItemPage): void }[] = [];
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected' }),
    getExternalSources: () =>
      ['fixture.search', 'fixture.offline', 'fixture.no-search'].map((id) => ({
        descriptor: { id, capabilities: id === 'fixture.no-search' ? ['browse'] : ['search'] },
      })),
    listExternalSource: vi.fn(
      (_id: string, _context: unknown, input: ExternalSourceListInput, signal: AbortSignal) =>
        new Promise<ExternalItemPage>((resolve) => pending.push({ input, signal, resolve })),
    ),
    peekExternalSourceCover: vi.fn(() => 'blob:seen'),
    resolveExternalSourceCover: vi.fn(async () => 'blob:seen'),
  } as unknown as ExternalSourceRegistryPort;
  const session = new DiscoverySession(registry, {} as TrustedExternalSourceHostContext, 'search-adapter');
  const props = { model: model([novel({ title: 'Local', tags: ['tag'] })]), actions: actions() };
  const books = [...props.model.collection.booksByNovelId.values()];
  props.model.collection.visibleBooks = [];
  let settings: ReaderSettings = defaultSettings;
  const data = {
    discovery: {
      session,
      scope: 'search-adapter',
      active: false,
      config: { version: 1, tabs: [] },
      setActive: vi.fn(),
    },
    controller: { setView: vi.fn() },
    externalSources: {
      sources: ['fixture.search', 'fixture.offline', 'fixture.no-search'].map((id) => ({
        id,
        title: id,
        kind: 'catalog',
        connection: { state: id === 'fixture.offline' ? 'disconnected' : 'connected' },
      })),
      libraryWorks: [
        { connectorId: 'fixture.search', collectionRemoteId: 'detail:work' },
        { connectorId: 'fixture.search', collectionRemoteId: 'deleted', deletedAt: '2026-01-01' },
      ],
      close: vi.fn(),
      openDiscovery: vi.fn(),
    },
  } as unknown as SearchData;
  let adapter!: ReturnType<typeof useSearchAdapter>;
  function Harness() {
    const [current, setSettings] = useState(settings);
    data.preferences = {
      settings: current,
      updateSettings: (update) =>
        setSettings((previous) => {
          settings = typeof update === 'function' ? update(previous) : { ...previous, ...update };
          return settings;
        }),
    };
    adapter = useSearchAdapter(props, { books, externalWorks: [] }, data);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Harness));
  });
  return { data, props, session, registry, pending, adapter: () => adapter, renderer, settings: () => settings };
}

it('uses full local data, records eight recent terms through settings, and cancels on unmount', async () => {
  const f = fixture();
  expect(f.adapter().library('tag')).toHaveLength(1);
  expect(f.adapter().sources.map((source) => source.sourceId)).toEqual(['fixture.search']);
  expect(f.pending).toEqual([]);
  for (let i = 0; i < 10; i++) await act(async () => f.adapter().submit(`term${i}`));
  expect(f.adapter().recent).toEqual(['term9', 'term8', 'term7', 'term6', 'term5', 'term4', 'term3', 'term2']);
  await act(async () => f.adapter().submit(' TERM5 '));
  expect(f.adapter().submitted).toBe('TERM5');
  expect(f.pending.at(-1)?.input.query).toBe('TERM5');
  expect(f.adapter().recent).toEqual(['TERM5', 'term9', 'term8', 'term7', 'term6', 'term4', 'term3', 'term2']);
  act(() => f.adapter().removeRecent('term5'));
  expect(f.settings().recentSearches).not.toContain('TERM5');
  act(() => f.adapter().clearRecent());
  expect(f.settings().recentSearches).toEqual([]);
  const signal = f.pending.at(-1)!.signal;
  act(() => f.renderer.unmount());
  expect(signal.aborted).toBe(true);
  f.session.dispose();
});

it('reuses cover lookup, projects ownership, opens detail, and hands the exact query to discovery', async () => {
  vi.stubGlobal('window', {});
  const f = fixture();
  await act(async () => f.adapter().submit('query words'));
  await act(async () =>
    f.pending[0].resolve({
      items: ['work', 'deleted'].map((id) => ({
        key: { connectorId: 'fixture.search', remoteId: id },
        kind: 'work',
        importability: 'supported',
        title: id,
        navigationRef: `detail:${id}`,
        coverRef: { connectorId: 'fixture.search', remoteId: `cover:${id}` },
      })),
    }),
  );
  const group = f.adapter().sources[0];
  expect(group.status).toBe('ready');
  expect(group.items.map((item) => item.owned)).toEqual([true, false]);
  expect(group.items[0].thumbnailUrl).toBe('blob:seen');
  expect(await group.items[0].loadCover!(new AbortController().signal)).toBe('blob:seen');
  openSearch();
  group.items[0].open();
  expect(getSearchRoute()).toBeUndefined();
  expect(f.data.externalSources.openDiscovery).toHaveBeenCalledWith(
    'fixture.search',
    { parentRef: 'detail:work' },
    'work',
  );
  openSearch();
  group.openAll!();
  expect(getSearchRoute()).toBeUndefined();
  expect(f.data.discovery!.setActive).toHaveBeenCalledWith(true);
  let destination!: ReturnType<typeof useDiscoveryScreenState>;
  let sourceView!: ReturnType<typeof useDiscoverySourceView>;
  vi.spyOn(f.session, 'list').mockResolvedValue({ items: [] });
  function Destination() {
    destination = useDiscoveryScreenState({
      library: f.props,
      discovery: f.data.discovery!,
      sources: f.data.externalSources,
      open: vi.fn(),
    });
    sourceView = useDiscoverySourceView({
      section: destination.dedicated!,
      source: f.data.externalSources.sources[0],
      session: f.session,
      refresh: 0,
    });
    return null;
  }
  let target!: ReactTestRenderer;
  act(() => {
    target = create(createElement(Destination));
  });
  expect(destination.query).toBe('query words');
  expect(destination.dedicated?.sourceId).toBe('fixture.search');
  expect(sourceView.input).toMatchObject({ browseMode: 'search', query: 'query words' });
  act(() => {
    target.unmount();
    f.renderer.unmount();
  });
  f.session.dispose();
});
