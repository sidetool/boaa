import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollChapterBoundary } from './use-scroll-chapter-boundary';

class TestElement extends EventTarget {
  scrollTop = 400;
  scrollHeight = 1000;
  clientHeight = 600;
  classList = { remove: vi.fn(), contains: () => false };
  style = { removeProperty: vi.fn() };
  constructor(readonly interactive = false) {
    super();
  }
  closest() {
    return this.interactive ? this : null;
  }
}

describe('chapter boundary control ownership', () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Element', TestElement);
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
      cancelAnimationFrame: clearTimeout,
      matchMedia: () => ({ matches: true }),
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function mount() {
    const root = new TestElement();
    const rootRef = { current: root as unknown as HTMLElement };
    const next = vi.fn();
    let boundary!: ReturnType<typeof useScrollChapterBoundary>;
    function Harness() {
      boundary = useScrollChapterBoundary({
        rootRef,
        contentRef: rootRef,
        chapterId: 'chapter-one',
        enabled: true,
        onNextChapter: next,
      });
      return null;
    }
    act(() => {
      renderer = create(<Harness />);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(boundary.armed).toBe(true);
    return { root, next, boundary };
  }

  it('leaves an armed mouse control click with the control and still accepts a body gesture', async () => {
    const { root, next, boundary } = mount();
    expect(boundary.onPointerDown(400, 'mouse', new TestElement(true))).toBe(false);
    await act(async () => boundary.onVerticalGesture(80, 'mouse'));
    expect(next).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(boundary.onPointerDown(400, 'mouse', root)).toBe(true);
    await act(async () => boundary.onVerticalGesture(80, 'mouse'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not turn a chapter for a touch that began on an interactive control', async () => {
    const { root, next } = mount();
    function touch(type: string, target: TestElement, y: number) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, {
        target: { value: target },
        touches: { value: type === 'touchend' ? [] : [{ clientY: y }] },
      });
      root.dispatchEvent(event);
      return event;
    }
    const control = new TestElement(true);
    await act(async () => {
      touch('touchstart', control, 400);
      expect(touch('touchmove', control, 300).defaultPrevented).toBe(false);
      touch('touchend', control, 300);
    });
    expect(next).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      touch('touchstart', root, 400);
      expect(touch('touchmove', root, 300).defaultPrevented).toBe(true);
      touch('touchend', root, 300);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
