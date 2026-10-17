import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useStartupScreen } from '../../features/navigation/use-startup-screen';

import { getHomeActive, setHomeActive } from './route';
afterEach(() => {
  setHomeActive(false);
  vi.unstubAllGlobals();
});
it('settles home before history, clears remembered shelf, applies only once', () => {
  vi.stubGlobal('window', new EventTarget());
  const input: Parameters<typeof useStartupScreen>[0] = {
    ready: false,
    preference: undefined,
    shelvesReady: false,
    shelves: [],
    discoveryReady: false,
    tabs: [],
    discoveryScope: 'test',
    atLibraryRoot: true,
    setShelf: vi.fn(),
    openDiscovery: vi.fn(),
  };
  let settled = false;
  function Harness() {
    settled = useStartupScreen({ ...input });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  expect(getHomeActive()).toBe(false);
  act(() => {
    input.ready = true;
    renderer.update(<Harness />);
  });
  expect(settled).toBe(true);
  expect(getHomeActive()).toBe(true);
  expect(input.setShelf).toHaveBeenCalledExactlyOnceWith(undefined);
  act(() => {
    setHomeActive(false);
    renderer.update(<Harness />);
  });
  expect(getHomeActive()).toBe(false);
  act(() => renderer.unmount());
});
