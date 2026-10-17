import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Virtualizer, VirtualItem } from '@tanstack/react-virtual';
import { useReaderScrollPosition } from './use-reader-scroll-position';

const observed = vi.hoisted(() => ({
  offset: undefined as undefined | ((offset: number, scrolling: boolean) => void),
}));
vi.mock('@tanstack/react-virtual', () => ({
  observeElementOffset: (_instance: unknown, callback: typeof observed.offset) => {
    observed.offset = callback;
    return () => {};
  },
  elementScroll: vi.fn(),
}));

describe('native scroll coordinate boundaries', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
  });

  it('reopens native upward range during a held gesture without moving the source', () => {
    vi.useFakeTimers();
    const root = Object.assign(new EventTarget(), { scrollTop: 300, scrollHeight: 3000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    let position!: ReturnType<typeof useReaderScrollPosition>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, { current: null }, true);
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    const virtualizer = {
      scrollOffset: 300,
      range: { startIndex: 20 },
      scrollToOffset: vi.fn(),
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    position.observeOffset(virtualizer, (offset) => {
      virtualizer.scrollOffset = offset;
    });
    const touch = new Event('touchstart');
    Object.defineProperty(touch, 'touches', { value: [{ clientY: 400 }] });
    act(() => {
      root.dispatchEvent(touch);
    });
    act(() => {
      position.adjustMeasuredSize({ index: 19 } as VirtualItem, 900, virtualizer);
      observed.offset!(300, true);
    });
    expect(position.shift).toBe(900);
    expect(root.scrollTop).toBe(300); // Native momentum remains untouched away from the boundary.
    const sourceY = 1500 - position.shift; // At native offset zero, before rebasing.
    act(() => {
      root.scrollTop = 0;
      observed.offset!(0, true);
    });
    expect(position.shift).toBe(0);
    expect(root.scrollTop).toBe(900);
    expect(1500 - position.shift - root.scrollTop).toBe(sourceY);
    expect(virtualizer.scrollOffset).toBe(900);
    act(() => {
      root.scrollTop -= 200;
      observed.offset!(root.scrollTop, true);
    });
    expect(virtualizer.scrollOffset).toBe(700); // The same held gesture can keep moving upward.
  });
});
