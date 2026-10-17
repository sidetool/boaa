import { createElement, useRef } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { searchVisibleTop, useReaderSearchInset } from './reader-search-occlusion';
afterEach(() => vi.unstubAllGlobals());
it('uses actual overlapping bounds for mobile, expanded results and offscreen chrome', () => {
  const viewport = { top: 0, bottom: 800, left: 0, right: 400 };
  const rect = (top: number, bottom: number) => ({ ...viewport, top, bottom });
  expect(searchVisibleTop(viewport, 60, [rect(0, 58), rect(58, 112), rect(112, 440)])).toBe(440);
  expect(searchVisibleTop(viewport, 60, [rect(-60, 0), rect(66, 210)])).toBe(210);
  expect(searchVisibleTop(viewport, 60, [{ ...rect(66, 440), left: 500, right: 800 }])).toBe(60);
  expect(searchVisibleTop(viewport, 60, [])).toBe(60);
});
it('updates the search-only inset for expanded results and restores zero for ordinary navigation', () => {
  let bottom = 240;
  let resize!: () => void;
  const layer = { getBoundingClientRect: () => ({ top: 66, bottom, left: 0, right: 400 }) };
  const screen = Object.assign(new EventTarget(), { querySelectorAll: () => [layer] });
  const root = {
    closest: () => screen,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 400 }),
  } as unknown as HTMLElement;
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      getComputedStyle: () => ({ paddingTop: '60', visibility: 'visible', display: 'block', opacity: '1' }),
    }),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let inset = 0;
  function Probe({ enabled }: { enabled: boolean }) {
    inset = useReaderSearchInset(useRef(root), enabled);
    return null;
  }
  let app!: ReturnType<typeof create>;
  act(() => {
    app = create(createElement(Probe, { enabled: true }));
  });
  expect(inset).toBe(180);
  act(() => {
    bottom = 430;
    resize();
  });
  expect(inset).toBe(370);
  act(() => app.update(createElement(Probe, { enabled: false })));
  expect(inset).toBe(0);
  act(() => app.unmount());
});
