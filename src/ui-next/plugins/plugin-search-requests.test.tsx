import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { PLUGIN_SEARCH_EVENT, pluginSearchQuery, usePluginSearchRequests } from './plugin-search-requests';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const search = (detail: unknown) => new CustomEvent(PLUGIN_SEARCH_EVENT, { detail });

it('accepts only a trimmed, bounded query string', () => {
  expect(pluginSearchQuery(search({ query: '  예제 제목 ' }))).toBe('예제 제목');
  expect(pluginSearchQuery(search({ query: '   ' }))).toBeUndefined();
  expect(pluginSearchQuery(search({ query: 'a'.repeat(257) }))).toBeUndefined();
  expect(pluginSearchQuery(search({ query: 1 }))).toBeUndefined();
  expect(pluginSearchQuery(search(null))).toBeUndefined();
  expect(pluginSearchQuery(new Event(PLUGIN_SEARCH_EVENT))).toBeUndefined();
});

it('handles a plugin search on the next task and stops after unmount', () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  const handle = vi.fn();
  function Probe() {
    usePluginSearchRequests(handle);
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  target.dispatchEvent(search({ query: '예제 제목' }));
  // The view runtime replies to the guest before this runs, so closing its frame can't reject that call.
  expect(handle).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(handle).toHaveBeenCalledExactlyOnceWith('예제 제목');

  target.dispatchEvent(search({ query: '다른 제목' }));
  act(() => renderer!.unmount());
  renderer = undefined;
  vi.runAllTimers();
  target.dispatchEvent(search({ query: '늦은 제목' }));
  vi.runAllTimers();
  expect(handle).toHaveBeenCalledTimes(1);
});
