import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rememberNavigationViewState } from '../navigation/navigation-view-state';
import { readDiscoverySelection, saveDiscoverySelection, useDiscoverySelection } from './use-discovery-selection';
let root: ReactTestRenderer | undefined;
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;

  vi.unstubAllGlobals();
});
function mount(scope: string, first = 'first', sources = ['source']) {
  let value!: ReturnType<typeof useDiscoverySelection>;
  function Harness() {
    value = useDiscoverySelection(scope, first, sources);
    return null;
  }
  act(() => {
    root = create(<Harness />);
  });
  return {
    get current() {
      return value;
    },
  };
}
it('restores a persisted tab on a fresh session and saves explicit tab/source changes', () => {
  saveDiscoverySelection('reload', { selected: 'second', quickSource: 'source' });
  const h = mount('reload');
  expect(h.current.selected).toBe('second');
  expect(h.current.quickSource).toBe('source');
  act(() => {
    h.current.setSelected('third');
    h.current.setQuickSource(undefined);
  });
  expect(readDiscoverySelection('reload')).toEqual({ selected: 'third', quickSource: undefined });
});
it('gives the current in-memory navigation destination precedence over the reload preference', () => {
  saveDiscoverySelection('history', { selected: 'second' });
  rememberNavigationViewState('discovery-tab:history', 'from-home');
  expect(mount('history').current.selected).toBe('from-home');
  expect(readDiscoverySelection('history').selected).toBe('second');
});

it('isolates settings scopes, ignores removed quick sources, and tolerates blocked/corrupt storage', () => {
  saveDiscoverySelection('one', { selected: 'second', quickSource: 'removed' });
  expect(readDiscoverySelection('two').selected).toBeUndefined();
  expect(mount('one').current.quickSource).toBeUndefined();
  storage.set('boaa.discovery-selection.v1:broken', '{');
  expect(readDiscoverySelection('broken')).toEqual({});
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  });
  expect(() => saveDiscoverySelection('one', { selected: 'third' })).not.toThrow();
  expect(readDiscoverySelection('one')).toEqual({});
});
