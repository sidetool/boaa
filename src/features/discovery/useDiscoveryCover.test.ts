import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useDiscoveryCover } from './useDiscoveryCover';
import type { DiscoverySession } from './discovery-session';

afterEach(() => vi.unstubAllGlobals());
it('exposes a memory hit on the first render before the visibility observer runs', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const frames: Array<string | undefined> = [];
  const key = { connectorId: 'source', remoteId: 'work' };
  const session = { peekCover: () => 'blob:cached', cover: vi.fn() } as unknown as DiscoverySession;
  function Probe() {
    const value = useDiscoveryCover({
      item: { key, coverRef: key, title: 'Work', kind: 'work', importability: 'supported' },
      session,
      showCover: true,
    });
    frames.push(value.url);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Probe));
  });
  expect(frames[0]).toBe('blob:cached');
  expect(session.cover).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
