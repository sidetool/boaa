import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { UiNextWorkspace } from '../Workspace';
import { useAppBrowserNavigation } from '../../features/navigation/useAppBrowserNavigation';
import { testWorkspaceState } from '../../features/book-workspace/book-workspace-test-fixtures';
import { actions, model } from '../test-fixtures';
import { getHomeActive, setHomeActive } from '../home/route';
import type { UiNextShellProps } from '../shell/contract';
import type { UiNextSearchScreenProps } from './contract';
import { getSearchRoute, openSearch, setSearchRoute } from './route';
import { closePluginView, openPluginView, usePluginViewRoute } from '../plugins/view-route';
import { usePluginSearchRequests, PLUGIN_SEARCH_EVENT } from '../plugins/plugin-search-requests';

let shell!: UiNextShellProps;
let screen: UiNextSearchScreenProps | undefined;
vi.mock('../shell/UiNextShell', () => ({
  UiNextShell: (props: UiNextShellProps) => {
    shell = props;
    return props.children;
  },
}));
vi.mock('./UiNextSearchScreen', () => ({
  UiNextSearchScreen: (props: UiNextSearchScreenProps) => {
    screen = props;
    useEffect(
      () => () => {
        screen = undefined;
      },
      [],
    );
    return null;
  },
}));
afterEach(() => {
  setSearchRoute(undefined);
  setHomeActive(false);
  closePluginView();
  vi.unstubAllGlobals();
});

it('routes the existing shell search button to openSearch without passing its click event as a query', async () => {
  const { UiNextShell } = await vi.importActual<typeof import('../shell/UiNextShell')>('../shell/UiNextShell');
  vi.stubGlobal('document', Object.assign(new EventTarget(), { querySelector: () => ({}) }));
  const openSearch = vi.fn();
  const focusSearch = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(UiNextShell, {
        activeTab: 'home',
        isReader: false,
        searchFocusRequest: 0,
        openHome: vi.fn(),
        openLibraryRoot: vi.fn(),
        openSettings: vi.fn(),
        openSearch,
        focusSearch,
        children: null,
      }),
    );
  });
  act(() => renderer.root.findByProps({ 'aria-label': '검색' }).props.onClick({ type: 'click' }));
  expect(openSearch).toHaveBeenCalledWith();
  expect(focusSearch).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});

function browser() {
  const entries: unknown[] = [null];
  let index = 0;
  const events = new EventTarget();
  const go = (delta: number) => {
    index = Math.max(0, Math.min(entries.length - 1, index + delta));
    const event = new Event('popstate');
    Object.assign(event, { state: entries[index] });
    queueMicrotask(() => events.dispatchEvent(event));
  };
  return {
    history: {
      get state() {
        return entries[index];
      },
      pushState(value: unknown) {
        entries.splice(index + 1);
        entries.push(value);
        index++;
      },
      replaceState(value: unknown) {
        entries[index] = value;
      },
      back: () => go(-1),
      forward: () => go(1),
      go,
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    entries,
    dispatchEvent: events.dispatchEvent.bind(events),
  };
}

it.each([false, true])(
  'opens search above the mounted workspace; close/back/forward preserve home and inline search (pending=%s)',
  async (pending) => {
    const window = browser();
    vi.stubGlobal('window', window);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      callback();
      return 0;
    });
    setHomeActive(true);
    const state = testWorkspaceState({ view: 'library', libraryQuery: 'inline', navigationPending: pending });
    const options = {
      enabled: true,
      state,
      workspace: { getSnapshot: () => state, cancelNavigation: vi.fn() },
      sources: { open: false, close: vi.fn() },
      discovery: { active: false, setActive: vi.fn() },
      getNovel: vi.fn(),
      notify: vi.fn(),
    } as unknown as Parameters<typeof useAppBrowserNavigation>[0];
    const props = { model: model([]), actions: actions() };
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Underlying() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return null;
    }
    function Harness() {
      useAppBrowserNavigation(options);
      return createElement(UiNextWorkspace, { ...props, view: 'library', children: createElement(Underlying) });
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(createElement(Harness));
    });
    try {
      act(() => shell.openSearch!('tag'));
      expect(window.entries).toHaveLength(2);
      expect(screen?.initialQuery).toBe('tag');
      expect(getHomeActive()).toBe(true);
      expect(mounted).toHaveBeenCalledOnce();
      expect(unmounted).not.toHaveBeenCalled();
      expect(props.actions.presentation.goHome).not.toHaveBeenCalled();
      expect(shell.searchFocusRequest).toBe(0);
      await act(async () => screen!.close());
      expect(getSearchRoute()).toBeUndefined();
      expect(screen).toBeUndefined();
      expect(options.sources.close).not.toHaveBeenCalled();
      expect(options.workspace.cancelNavigation).not.toHaveBeenCalled();
      await act(async () => window.history.forward());
      expect(screen?.initialQuery).toBe('tag');
      await act(async () => window.history.back());
      expect(getSearchRoute()).toBeUndefined();
      expect(state.libraryQuery).toBe('inline');
      act(() => shell.focusSearch());
      expect(shell.searchFocusRequest).toBe(1);
      expect(props.actions.presentation.goHome).toHaveBeenCalledOnce();
      expect(options.notify).not.toHaveBeenCalled();
      act(() => shell.openSearch!());
      const beforeModal = window.entries.length;
      options.layers = [{ id: 'fixture-modal', open: true, dismiss: vi.fn() }];
      act(() => renderer.update(createElement(Harness)));
      expect(window.entries).toHaveLength(beforeModal + 1);
    } finally {
      act(() => renderer.unmount());
    }
  },
);

it.each([false, true])('keeps plugin search open across asynchronous history (batched=%s)', async (batched) => {
  const window = browser();
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 0;
  });
  setHomeActive(true);
  const state = testWorkspaceState({ view: 'library' });
  const options = {
    enabled: true,
    state,
    workspace: {
      getSnapshot: () => state,
      cancelNavigation: vi.fn(),
      setView: vi.fn(),
      setLibraryQuery: vi.fn(),
      setLibraryFilter: vi.fn(),
      setLibrarySort: vi.fn(),
      setLibraryViewMode: vi.fn(),
    },
    sources: { open: false, close: vi.fn() },
    discovery: { active: false, setActive: vi.fn() },
    getNovel: vi.fn(),
    notify: vi.fn(),
  } as unknown as Parameters<typeof useAppBrowserNavigation>[0];
  function Harness() {
    const route = usePluginViewRoute();
    usePluginSearchRequests((query) => {
      const handoff = () => {
        closePluginView();
        openSearch(query);
      };
      if (batched) act(handoff);
      else handoff();
    });
    useAppBrowserNavigation({
      ...options,
      layers: [{ id: 'plugin-view', open: Boolean(route), dismiss: closePluginView }],
    });
    return createElement(UiNextWorkspace, { model: model([]), actions: actions(), view: 'library', children: null });
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Harness));
  });
  try {
    act(() => openPluginView('fixture', 'browse'));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLUGIN_SEARCH_EVENT, { detail: { query: 'A title' } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getSearchRoute()?.initialQuery).toBe('A title');
    expect(screen?.initialQuery).toBe('A title');
    expect(options.notify).not.toHaveBeenCalled();
    await act(async () => screen!.close());
    expect(getSearchRoute()).toBeUndefined();
    expect(getHomeActive()).toBe(true);
  } finally {
    act(() => renderer.unmount());
  }
});
