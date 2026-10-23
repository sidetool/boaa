import { Virtualizer } from '@tanstack/react-virtual';
import { expect, it, vi } from 'vitest';
import { cancelVirtualScroll } from './cancel-virtual-scroll';

it.each(['auto', 'smooth'] as const)(
  'retires a real %s library job without scrolling or synchronous native-scroll measurements',
  (behavior) => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    const targetWindow = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++sequence, callback);
        return sequence;
      },
      cancelAnimationFrame: (id: number) => {
        frames.delete(id);
      },
      performance,
    } as unknown as Window & typeof globalThis;
    const root = { scrollHeight: 20000, clientHeight: 600, scrollTop: 100 } as HTMLDivElement;
    const measure = vi.fn(() => 80);
    const write = vi.fn();
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count: 200,
      getScrollElement: () => root,
      estimateSize: () => 80,
      observeElementRect: () => undefined,
      observeElementOffset: () => undefined,
      scrollToFn: write,
      measureElement: measure,
    });
    virtualizer.scrollElement = root;
    virtualizer.targetWindow = targetWindow;
    virtualizer.scrollRect = { width: 390, height: 600 };
    virtualizer.scrollOffset = 100;
    virtualizer.getTotalSize();
    virtualizer.scrollToIndex(30, { behavior });
    const internals = virtualizer as unknown as {
      scrollState: unknown;
      rafId: number | null;
      _intendedScrollOffset: number | null;
    };
    expect(internals.scrollState).not.toBeNull();
    expect(frames.size).toBe(1);
    expect(internals._intendedScrollOffset).not.toBeNull();
    write.mockClear();
    cancelVirtualScroll(virtualizer);
    root.scrollTop = 150; // The browser takes over before the next animation frame.
    virtualizer.scrollOffset = 150;
    virtualizer.isScrolling = true;
    virtualizer.measureElement({ getAttribute: () => '30', isConnected: true } as unknown as Element);
    expect(internals.scrollState).toBeNull();
    expect(internals.rafId).toBeNull();
    expect(internals._intendedScrollOffset).toBeNull();
    expect(frames.size).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(virtualizer.scrollOffset).toBe(150);
    expect(virtualizer.scrollElement).toBe(root);
  },
);
