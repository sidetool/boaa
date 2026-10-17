import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppBrowserNavigation } from '../../features/navigation/useAppBrowserNavigation';
import { dispatchAndroidBackEscape } from '../../platform/android/app-navigation';
import { createUiNextNavigation } from '../shell/navigation';
import { actions, model } from '../test-fixtures';

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined as unknown as ReactTestRenderer;

  vi.unstubAllGlobals();
});

function setup() {
  const window = new EventTarget();
  const entries: unknown[] = [null];
  let index = 0;
  const history = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(++index);
      entries.push(state);
    },
    replaceState(state: unknown) {
      entries[index] = state;
    },
    back: vi.fn(() => {
      index = Math.max(0, index - 1);
      queueMicrotask(() => window.dispatchEvent(Object.assign(new Event('popstate'), { state: entries[index] })));
    }),
    go: vi.fn(),
  };
  Object.assign(window, { history });
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  });
  const source = { sourceId: 'fixture.source', breadcrumbs: [{ parentRef: 'work' }] };
  const sources = {
    open: true,
    loading: false,
    streaming: undefined as object | undefined,
    captureNavigation: () => source,
    close: vi.fn(),
    restoreNavigation: vi.fn(),
    closeStream: vi.fn(() => {
      sources.streaming = undefined;
      render();
    }),
  };
  const workspace = { cancelNavigation: vi.fn(), getSnapshot: () => ({ view: 'library' }), setView: vi.fn() };
  const notify = vi.fn();
  function Harness() {
    useAppBrowserNavigation({
      enabled: true,
      sources,
      workspace,
      state: { view: 'library' },
      getNovel: vi.fn(),
      notify,
    } as unknown as Parameters<typeof useAppBrowserNavigation>[0]);
    return null;
  }
  function render() {
    if (renderer) renderer.update(<Harness />);
    else renderer = create(<Harness />);
  }
  act(render);
  return {
    history,
    sources,
    workspace,
    notify,
    start() {
      act(() => {
        sources.streaming = {};
        render();
      });
    },
    async back() {
      await act(async () => {
        history.back();
      });
    },
    async escape(android = false) {
      let handled = false;
      await act(async () => {
        const createEvent = () =>
          Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }) as KeyboardEvent;
        if (android) handled = dispatchAndroidBackEscape(window, createEvent);
        else {
          const event = createEvent();
          window.dispatchEvent(event);
          handled = event.defaultPrevented;
        }
      });
      return handled;
    },
  };
}

it('exposes stream overlay separately from the normal reader route and retains the discovery tab', () => {
  const p = { model: model([]), actions: actions() };
  p.model.externalSources.active = true;
  p.model.externalSources.streaming = true;
  expect(createUiNextNavigation(p, 'library', 0, vi.fn())).toMatchObject({
    readerOverlay: true,
    isReader: false,
    activeTab: 'discovery',
  });
  p.model.externalSources.streaming = false;
  expect(createUiNextNavigation(p, 'library', 0, vi.fn()).readerOverlay).toBe(false);
});
it.each(['browser', 'escape', 'android', 'button'])(
  'closes the stream first with %s back without reopening the detail catalog',
  async (method) => {
    const h = setup();
    h.start();
    if (method === 'browser') await h.back();
    else if (method === 'button') await act(async () => h.sources.closeStream());
    else expect(await h.escape(method === 'android')).toBe(true);
    expect(h.sources.streaming).toBeUndefined();
    expect(h.sources.close).not.toHaveBeenCalled();
    expect(h.sources.restoreNavigation).not.toHaveBeenCalled();
    expect(h.workspace.setView).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.history.back).toHaveBeenCalledTimes(1);
  },
);
