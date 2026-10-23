import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { HomeRowView } from './contract';
import { useRowRefresh } from './use-row-refresh';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('refreshes near rows at expiry and on visible return, suspending while hidden or unmounted', () => {
  vi.useFakeTimers();
  const browser = new EventTarget();
  const documentEvents = new EventTarget();
  const document = Object.assign(documentEvents, { visibilityState: 'visible' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', document);
  const requestLoad = vi.fn();
  const row: HomeRowView = {
    config: { id: 'row', kind: 'source', visible: true },
    title: '목록',
    items: [],
    status: 'ready',
    loadKey: 'first',
    refreshAt: Date.now() + 60_000,
    requestLoad,
  };
  function Harness({ near = true }: { near?: boolean }) {
    useRowRefresh(row, near);
    return null;
  }
  act(() => {
    renderer = create(<Harness near={false} />);
  });
  expect(requestLoad).not.toHaveBeenCalled();
  act(() => renderer!.update(<Harness />));
  expect(requestLoad).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(requestLoad).toHaveBeenCalledTimes(2);
  document.visibilityState = 'hidden';
  act(() => {
    browser.dispatchEvent(new Event('focus'));
  });
  expect(requestLoad).toHaveBeenCalledTimes(2);
  document.visibilityState = 'visible';
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(requestLoad).toHaveBeenCalledTimes(3);
  act(() => renderer!.unmount());
  renderer = undefined;
  browser.dispatchEvent(new Event('focus'));
  expect(requestLoad).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
