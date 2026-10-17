import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppBrowserNavigation } from '../../features/navigation/useAppBrowserNavigation';
import { handleAppBackNavigation } from '../../platform/android/app-navigation';
import { navigateAppBack } from '../../features/navigation/browser-navigation';
import { testNovel, testWorkspaceState } from '../../features/book-workspace/book-workspace-test-fixtures';
import { createUiNextNavigation } from '../shell/navigation';
import { actions, model } from '../test-fixtures';
import { getHomeActive, setHomeActive } from './route';
import { resolveStartupScreen } from '../../features/navigation/use-startup-screen';

afterEach(() => {
  setHomeActive(false);
  vi.unstubAllGlobals();
});

function browser() {
  const entries: unknown[] = [null];
  let index = 0;
  const events = new EventTarget();
  const go = (delta: number) => {
    index = Math.max(0, Math.min(entries.length - 1, index + delta));
    const event = new Event('popstate');
    Object.assign(event, { state: entries[index] });
    events.dispatchEvent(event);
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
  };
}
it('records home/library in existing history, restores shelf, supports native back and browser forward', async () => {
  const window = browser();
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 0;
  });
  setHomeActive(true);
  const state = testWorkspaceState({ view: 'library' });
  const shelf = {
    activeShelfId: undefined as string | undefined,
    setActiveShelf: vi.fn((id?: string) => {
      shelf.activeShelfId = id;
    }),
  };
  const options = {
    enabled: true,
    state,
    shelf,
    workspace: {
      getSnapshot: () => state,
      cancelNavigation: vi.fn(),
      setLibraryQuery: vi.fn(),
      setLibraryFilter: vi.fn(),
      setLibrarySort: vi.fn(),
      setLibraryViewMode: vi.fn(),
      setView: vi.fn(),
    },
    sources: { open: false, close: vi.fn() },
    discovery: { active: false, setActive: vi.fn() },
    getNovel: vi.fn(),
    notify: vi.fn(),
  } as unknown as Parameters<typeof useAppBrowserNavigation>[0];
  function Harness() {
    useAppBrowserNavigation(options);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  const native = { layers: [], view: 'library' as const, returnToChapters: vi.fn(), returnToLibrary: vi.fn() };
  try {
    expect(handleAppBackNavigation(native).handled).toBe(false);
    const props = { model: model([]), actions: actions() };
    act(() => {
      createUiNextNavigation(props, 'library', 0, vi.fn()).openLibraryRoot();
    });
    expect(getHomeActive()).toBe(false);
    expect(window.entries).toHaveLength(2);
    // Save a shelf in the current library entry, then visit home explicitly.
    shelf.activeShelfId = 's1';
    act(() => renderer.update(<Harness />));
    act(() => {
      createUiNextNavigation(props, 'library', 0, vi.fn(), false).openHome();
    });
    expect(getHomeActive()).toBe(true);
    await act(async () => {
      window.history.back();
      await Promise.resolve();
    });
    expect(getHomeActive()).toBe(false);
    expect(shelf.setActiveShelf).toHaveBeenLastCalledWith('s1');
    await act(async () => {
      expect(handleAppBackNavigation(native).handled).toBe(true);
      await Promise.resolve();
    });
    expect(getHomeActive()).toBe(true);
    expect(handleAppBackNavigation(native).handled).toBe(false);
    await act(async () => {
      window.history.forward();
      await Promise.resolve();
    });
    expect(getHomeActive()).toBe(false);
    expect(options.notify).not.toHaveBeenCalled();
  } finally {
    act(() => renderer.unmount());
  }
});
it('defaults to home without changing explicit destinations', () => {
  expect(resolveStartupScreen(undefined, [], [])).toEqual({ kind: 'home' });
  expect(resolveStartupScreen({ kind: 'home' }, [], [])).toEqual({ kind: 'home' });
  expect(resolveStartupScreen({ kind: 'library', shelfId: 'missing' }, [], [])).toEqual({
    kind: 'library',
    shelfId: undefined,
  });
  expect(resolveStartupScreen({ kind: 'discovery', tabId: 'tab' }, [], [{ id: 'tab' }])).toEqual({
    kind: 'discovery',
    tabId: 'tab',
  });
});

it.each([true, false])('restores the originating tab through reader → chapters → root (home=%s)', async (home) => {
  const window = browser();
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 0;
  });
  setHomeActive(home);
  let state = testWorkspaceState({ view: 'library' });
  const options = {
    enabled: true,
    state,
    workspace: {
      getSnapshot: () => state,
      cancelNavigation: vi.fn(),
      setLibraryQuery: vi.fn(),
      setLibraryFilter: vi.fn(),
      setLibrarySort: vi.fn(),
      setLibraryViewMode: vi.fn(),
      setChapterQuery: vi.fn(),
      setChapterReadFilter: vi.fn(),
      setChapterSort: vi.fn(),
      setView: vi.fn((view: typeof state.view) => {
        state = { ...state, view };
        options.state = state;
      }),
      returnToChapters: vi.fn(async () => {
        state = { ...state, view: 'chapters' };
        options.state = state;
      }),
    },
    sources: { open: false, close: vi.fn() },
    getNovel: vi.fn(),
    notify: vi.fn(),
  } as unknown as Parameters<typeof useAppBrowserNavigation>[0];
  function Harness() {
    useAppBrowserNavigation(options);
    return null;
  }
  let renderer!: ReactTestRenderer;
  const fallback = vi.fn();
  try {
    act(() => {
      renderer = create(<Harness />);
    });
    for (const view of ['chapters', 'reader'] as const) {
      state = { ...state, view, selectedNovel: testNovel() };
      options.state = state;
      act(() => renderer.update(<Harness />));
    }
    await act(async () => {
      navigateAppBack(fallback);
    });
    expect(state.view).toBe('chapters');
    expect(getHomeActive()).toBe(home);
    expect(
      createUiNextNavigation({ model: model([]), actions: actions() }, state.view, 0, vi.fn(), getHomeActive())
        .activeTab,
    ).toBe(home ? 'home' : 'library');
    await act(async () => {
      navigateAppBack(fallback);
    });
    expect(state.view).toBe('library');
    expect(getHomeActive()).toBe(home);
    expect(fallback).not.toHaveBeenCalled();
    expect(options.notify).not.toHaveBeenCalled();
  } finally {
    act(() => renderer.unmount());
  }
});
