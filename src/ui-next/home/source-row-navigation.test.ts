import { rememberDiscoverySourceDestination } from '../../features/discovery/source-view-navigation';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { BookWorkspaceScreensProps } from '../../features/book-workspace/BookWorkspaceScreens';
import { useHomeDiscovery } from './useHomeDiscovery';
import { useDiscoveryScreenState, type DiscoveryScreenProps } from '../../features/discovery/useDiscoveryScreenState';
import { useDiscoverySourceView } from '../../features/discovery/useDiscoverySourceView';
import { getHomeActive, setHomeActive } from './route';
afterEach(() => {
  setHomeActive(false);
  vi.unstubAllGlobals();
});

it('exposes the shared row builder and opens the discovery screen with the exact saved source filters', async () => {
  vi.stubGlobal('window', {});
  setHomeActive(true);
  const list = vi.fn().mockResolvedValue({ items: [] });
  const sources = [
    { id: 'fixture.source', title: 'Source', kind: 'catalog', connection: { state: 'connected' } },
    { id: 'disabled', title: 'Disabled', kind: 'catalog', connection: { state: 'unavailable' } },
    { id: 'files', title: 'Files', kind: 'cloud_file', connection: { state: 'connected' } },
  ];
  const props = {
    discovery: {
      scope: 'source-home-navigation',
      config: { version: 1, tabs: [] },
      setActive: vi.fn(),
      session: {
        key: (source: string, input: unknown) => JSON.stringify([source, input]),
        registry: { getExternalSources: () => [] },
        restore: async () => undefined,
        list,
        peek: () => undefined,
        railPositions: new Map(),
        scrollPositions: new Map(),
      },
    },
    externalSources: { sources, libraryWorks: [], close: vi.fn(), openDiscovery: vi.fn() },
    controller: { setView: vi.fn() },
  } as unknown as BookWorkspaceScreensProps;
  let home!: NonNullable<ReturnType<typeof useHomeDiscovery>>;
  let screen!: ReturnType<typeof useDiscoveryScreenState>;
  let view!: ReturnType<typeof useDiscoverySourceView>;
  function Home() {
    home = useHomeDiscovery(props)!;
    return null;
  }
  function Destination() {
    screen = useDiscoveryScreenState({
      discovery: props.discovery,
      sources: props.externalSources,
      open: vi.fn(),
    } as unknown as DiscoveryScreenProps);
    return null;
  }
  function Preview() {
    view = useDiscoverySourceView({
      section: screen.dedicated!,
      source: props.externalSources.sources[0],
      session: props.discovery!.session,
      refresh: 0,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Home));
  });
  const section = {
    sourceId: 'fixture.source',
    mode: 'latest' as const,
    title: 'Filtered row',
    parentRef: 'category',
    filters: [{ position: 0, value: 2 }],
  };
  try {
    expect(home.rowBuilder?.sources).toEqual([{ id: 'fixture.source', title: 'Source', kind: 'catalog' }]);
    expect(home.rowBuilder?.session).toBe(props.discovery!.session);
    expect(home.rowBuilder?.sourceView('fixture.source')).toBe(sources[0]);
    expect(home.rowBuilder?.sourceView('disabled')).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    act(() => home.row({ id: 'row', kind: 'source', visible: true, section }).openAll!());
    expect(getHomeActive()).toBe(false);
    expect(props.externalSources.close).toHaveBeenCalledOnce();
    expect(props.discovery!.setActive).toHaveBeenCalledWith(true);
    expect(props.externalSources.openDiscovery).not.toHaveBeenCalled();
    await act(async () => renderer.update(createElement(Destination)));
    expect(screen.quickSource).toBe(section.sourceId);
    expect(screen.dedicated).toMatchObject(section);
    await act(async () => renderer.update(createElement(Preview)));
    expect(view.input).toMatchObject({ parentRef: 'category', browseMode: 'search', filters: section.filters });
    expect(view.input.query).toBeUndefined();
  } finally {
    await act(async () => renderer.unmount());
  }
});

it('gives each explicit source-row entry fresh navigation controls without changing its saved section', () => {
  vi.stubGlobal('window', {});
  const section = {
    id: 'saved-row',
    sourceId: 'fixture.source',
    title: 'Row',
    mode: 'popular' as const,
    filters: [{ position: 0, value: 1 }],
  };
  const first = rememberDiscoverySourceDestination('entry-test', section);
  const next = rememberDiscoverySourceDestination('entry-test', section);
  expect(first.id).not.toBe(next.id);
  expect(section.id).toBe('saved-row');
  expect(next).toMatchObject({ sourceId: section.sourceId, mode: section.mode, filters: section.filters });
});
