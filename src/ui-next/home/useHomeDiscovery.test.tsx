import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { BookWorkspaceScreensProps } from '../../features/book-workspace/BookWorkspaceScreens';
import { useNavigationViewState } from '../../features/navigation/navigation-view-state';
import { useHomeDiscovery } from './useHomeDiscovery';
import { getHomeActive, setHomeActive } from './route';
afterEach(() => {
  setHomeActive(false);
  vi.unstubAllGlobals();
});
it('shares the app session before discovery mounts and opens the chosen tab with its quick source cleared', async () => {
  vi.stubGlobal('window', {});
  setHomeActive(true);
  const list = vi.fn().mockResolvedValue({ items: [] });
  const props = {
    discovery: {
      active: false,
      scope: 'home-navigation-test',
      setActive: vi.fn(),
      config: {
        tabs: [
          { id: 'target', title: '탭', sections: [{ id: 'section', sourceId: 'fixture.source', mode: 'popular' }] },
        ],
      },
      session: {
        key: () => 'shared-session',
        peek: () => undefined,
        registry: { getExternalSources: () => [] },
        restore: vi.fn().mockResolvedValue(undefined),
        list,
      },
    },
    externalSources: {
      sources: [{ id: 'fixture.source', title: '소스', kind: 'catalog', connection: { state: 'connected' } }],
      libraryWorks: [],
      close: vi.fn(),
    },
    controller: { setView: vi.fn() },
  } as unknown as BookWorkspaceScreensProps;
  let data!: ReturnType<typeof useHomeDiscovery>;
  let selected = '';
  let quick: string | undefined;
  function Harness() {
    data = useHomeDiscovery(props);
    return null;
  }
  function Navigation() {
    [selected] = useNavigationViewState('discovery-tab:home-navigation-test', 'default');
    [quick] = useNavigationViewState<string | undefined>('discovery-quick:home-navigation-test', 'old');
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  try {
    const row = () => data!.row({ id: 'row', kind: 'discovery', visible: true, discoveryTabId: data!.sections[0].id });
    expect(list).not.toHaveBeenCalled();
    await act(async () => {
      row().requestLoad!();
    });
    expect(row().status).toBe('ready');
    expect(list).toHaveBeenCalledOnce();
    act(() => {
      row().openAll!();
    });
    expect(props.discovery!.setActive).toHaveBeenCalledWith(true);
    expect(props.externalSources.close).toHaveBeenCalledOnce();
    expect(props.controller.setView).toHaveBeenCalledWith('library');
    expect(getHomeActive()).toBe(false);
    act(() => renderer.update(<Navigation />));
    expect(selected).toBe('target');
    expect(quick).toBeUndefined();
  } finally {
    act(() => renderer.unmount());
  }
});
