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

  it('preserves the visible row when shrinking a prefix clamps the native offset before compensation', () => {
    vi.useFakeTimers();
    const root = Object.assign(new EventTarget(), { scrollTop: 3000, scrollHeight: 5000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, contentRef, true);
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    const virtualizer = {
      scrollOffset: 3000,
      range: { startIndex: 30 },
      scrollToOffset: vi.fn(),
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    position.observeOffset(virtualizer, (offset) => {
      virtualizer.scrollOffset = offset;
    });
    act(() => {
      observed.offset!(3000, false);
    });
    const beforeY = 3200 - root.scrollTop;
    act(() => {
      root.scrollHeight = 1600;
      root.scrollTop = 1000; // Browser clamp during the shorter DOM commit.
      position.compensateStructure(-2500, 5);
    });
    expect(700 - position.shift - root.scrollTop).toBe(beforeY);
    expect(virtualizer.scrollOffset).toBe(500);
    expect(position.shift).toBe(-500);
    act(() => {
      observed.offset!(1000, false);
      vi.advanceTimersByTime(250);
    });
    expect(root.scrollTop).toBe(500);
    expect(position.shift).toBe(0);
    expect(700 - root.scrollTop).toBe(beforeY);
  });

  it.each([false, true])('counts prepend measurements once across an idle rebase (%s)', (rebase) => {
    vi.useFakeTimers();
    const root = Object.assign(new EventTarget(), { scrollTop: 2154, scrollHeight: 20000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, contentRef, true);
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    const virtualizer = {
      scrollOffset: 2154,
      range: { startIndex: 12 },
      scrollToOffset: vi.fn(),
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    position.observeOffset(virtualizer, (offset) => {
      virtualizer.scrollOffset = offset;
    });
    act(() => {
      observed.offset!(2154, false);
      position.adjustMeasuredSize({ index: 0 } as VirtualItem, 80, virtualizer);
    });
    // Capture the retained row after an earlier, unrelated size correction.
    const originalStart = 2672;
    const originalY = originalStart - root.scrollTop - position.shift;
    const baseline = position.measuredCompensation;
    act(() => {
      // New rows measure in the commit's ref phase before structural layout.
      position.adjustMeasuredSize({ index: 0 } as VirtualItem, 1686.585, virtualizer);
      if (rebase) vi.advanceTimersByTime(250);
    });
    act(() => {
      position.compensateStructure(9000.054, 60, baseline);
    });
    expect(originalStart + 9000.054 - root.scrollTop - position.shift).toBeCloseTo(originalY, 6);
    expect(virtualizer.scrollOffset).toBeCloseTo(2154 + 80 + 9000.054, 6);
    act(() => {
      // Late rows remain an ordinary measurement, not part of the old delta.
      position.adjustMeasuredSize({ index: 59 } as VirtualItem, 120, virtualizer);
      vi.advanceTimersByTime(250);
    });
    expect(position.shift).toBe(0);
    expect(originalStart + 9000.054 + 120 - root.scrollTop).toBeCloseTo(originalY, 6);
  });

  it('keeps hidden page preparation alive through touch, then yields to native input when ready', () => {
    const root = Object.assign(new EventTarget(), { scrollTop: 300, scrollHeight: 3000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness({ ready }: { ready: boolean }) {
      position = useReaderScrollPosition(rootRef, contentRef, true, ready);
      return null;
    }
    act(() => {
      renderer = create(<Harness ready={false} />);
    });
    const navigation = position.beginNavigation();
    const touch = new Event('touchstart');
    Object.defineProperty(touch, 'touches', { value: [{ clientY: 400 }] });
    act(() => {
      root.dispatchEvent(touch);
    });
    expect(position.isCurrentNavigation(navigation)).toBe(true);
    act(() => {
      root.dispatchEvent(new Event('touchend'));
      renderer!.update(<Harness ready />);
    });
    act(() => {
      root.dispatchEvent(touch);
    });
    expect(position.isCurrentNavigation(navigation)).toBe(false);
    expect(root.scrollTop).toBe(300);
  });

  it('reopens native upward range during a held gesture without moving the source', () => {
    vi.useFakeTimers();
    const root = Object.assign(new EventTarget(), { scrollTop: 300, scrollHeight: 3000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, contentRef, true);
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

  it('includes late prepended row measurements until native scrolling changes the visible anchor', () => {
    vi.useFakeTimers();
    const root = Object.assign(new EventTarget(), { scrollTop: 300, scrollHeight: 5000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, contentRef, true);
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    const virtualizer = {
      scrollOffset: 300,
      range: { startIndex: 0 },
      scrollToOffset: vi.fn(),
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    position.observeOffset(virtualizer, (offset) => {
      virtualizer.scrollOffset = offset;
    });
    act(() => {
      observed.offset!(300, false);
      position.compensateStructure(1000, 20);
      position.adjustMeasuredSize({ index: 19 } as VirtualItem, 212, virtualizer);
    });
    expect(position.shift).toBe(1212);
    expect(virtualizer.scrollOffset).toBe(1512);
    expect(root.scrollTop).toBe(300);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(root.scrollTop).toBe(1512);
    expect(position.shift).toBe(0);
    act(() => {
      observed.offset!(1512, true); // The controller's own rebase is not user movement.
      position.adjustMeasuredSize({ index: 19 } as VirtualItem, 20, virtualizer);
    });
    expect(position.shift).toBe(20);
    act(() => {
      virtualizer.range!.startIndex = 10;
      root.scrollTop = 1300;
      observed.offset!(1300, true);
      position.adjustMeasuredSize({ index: 15 } as VirtualItem, 100, virtualizer);
    });
    expect(position.shift).toBe(20); // No extra 100px from below the user's new anchor.
    expect(virtualizer.scrollOffset).toBe(1320);
  });

  it('opens a prepended range while a finger is held at native offset zero without a scroll event', () => {
    const root = Object.assign(new EventTarget(), { scrollTop: 0, scrollHeight: 5000, clientHeight: 600 });
    const rootRef = { current: root as unknown as HTMLDivElement };
    const contentRef = { current: null };
    let position!: ReturnType<typeof useReaderScrollPosition<HTMLDivElement>>;
    function Harness() {
      position = useReaderScrollPosition(rootRef, contentRef, true);
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    const virtualizer = {
      scrollOffset: 0,
      range: { startIndex: 0 },
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
      position.compensateStructure(1200, 20);
    });
    expect(root.scrollTop).toBe(1200);
    expect(position.shift).toBe(0);
    expect(virtualizer.scrollOffset).toBe(1200);
    act(() => {
      root.scrollTop -= 100;
      observed.offset!(root.scrollTop, true);
    });
    expect(virtualizer.scrollOffset).toBe(1100);
  });
});
