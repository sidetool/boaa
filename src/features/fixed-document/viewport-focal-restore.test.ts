import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewportFocalAnchor } from './viewport-focal-anchor';
import { renewViewportFocalRestore, scheduleViewportFocalRestore } from './viewport-focal-restore';

afterEach(() => vi.unstubAllGlobals());

describe('viewport focal restore ownership', () => {
  it('does not let an old second RAF consume a resize received before the next React commit', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++sequence, callback);
        return sequence;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    const frame = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const original: ViewportFocalAnchor = {
      pageIndex: 29,
      normalizedX: 0.5,
      normalizedY: 0.5,
      viewportOffsetX: 195,
      viewportOffsetY: 372,
    };
    const pending = { current: undefined as ViewportFocalAnchor | undefined };
    const scrollBy = vi.fn();
    const viewport = {
      current: {
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 788 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 800, width: 390, height: 600 }) }),
        scrollBy,
      } as unknown as HTMLElement,
    };
    renewViewportFocalRestore(pending, () => original);
    scheduleViewportFocalRestore(pending, viewport);
    frame(); // First layout RAF; second is queued against the old dimensions.
    const oldRequest = pending.current;
    const capture = vi.fn(() => ({ ...original, pageIndex: 0 }));
    renewViewportFocalRestore(pending, capture); // ResizeObserver fires before React commits.
    expect(capture).not.toHaveBeenCalled();
    expect(pending.current).toEqual(original);
    expect(pending.current).not.toBe(oldRequest);
    frame(); // Old second RAF must neither scroll nor clear the newer request.
    expect(scrollBy).not.toHaveBeenCalled();
    expect(pending.current).toEqual(original);
    scheduleViewportFocalRestore(pending, viewport); // New geometry commit.
    frame();
    frame();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 728 });
    expect(pending.current).toBeUndefined();
  });
});
