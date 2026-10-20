import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscoveryPagination } from './DiscoveryPagination';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it('observes the list scroller, requests once per page, and stops on errors, busy, end or unmount', () => {
  const observers: {
    fire(near: boolean): void;
    disconnect: ReturnType<typeof vi.fn>;
    options: IntersectionObserverInit;
  }[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        observers.push({
          fire: (near) =>
            callback([{ isIntersecting: near } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
          disconnect: this.disconnect,
          options,
        });
      }
    },
  );
  const root = {};
  const data = {
    items: [],
    browse: undefined,
    busy: false,
    error: '',
    hasPage: true,
    more: true,
    pageKey: 'first',
    loadMore: vi.fn(),
    retry: vi.fn(),
  };
  act(() => {
    renderer = create(<DiscoveryPagination data={data} />, { createNodeMock: () => ({ closest: () => root }) });
  });
  const update = () => act(() => renderer!.update(<DiscoveryPagination data={{ ...data }} />));
  expect(observers[0].options).toEqual({ root, rootMargin: '0px 0px 400px 0px' });
  act(() => observers[0].fire(false));
  expect(data.loadMore).not.toHaveBeenCalled();
  act(() => {
    observers[0].fire(true);
    observers[0].fire(true);
  });
  expect(data.loadMore).toHaveBeenCalledTimes(1);
  update();
  expect(observers).toHaveLength(1);
  data.busy = true;
  update();
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  act(() => observers[0].fire(true));
  expect(data.loadMore).toHaveBeenCalledTimes(1);
  data.busy = false;
  data.error = 'request failed';
  update();
  expect(observers).toHaveLength(1);
  expect(renderer!.toJSON()).toBeNull();
  data.error = '';
  data.pageKey = 'second';
  update();
  act(() => observers[1].fire(true));
  expect(data.loadMore).toHaveBeenCalledTimes(2);
  data.more = false;
  update();
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  expect(renderer!.toJSON()).toBeNull();
  data.more = true;
  data.pageKey = 'new-query';
  update();
  act(() => renderer!.unmount());
  act(() => observers[2].fire(true));
  expect(data.loadMore).toHaveBeenCalledTimes(2);
});
