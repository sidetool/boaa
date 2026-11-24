import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollChapterBoundary } from './use-scroll-chapter-boundary';

class TestElement extends EventTarget {
  scrollTop = 400;
  scrollHeight = 1000;
  clientHeight = 600;
  classList = { remove: vi.fn(), contains: () => false };
  style = { removeProperty: vi.fn() };
  constructor(
    readonly interactive = false,
    readonly nextTitle = false,
  ) {
    super();
  }
  closest(selector: string) {
    if (selector === '[data-chapter-swipe-next]:enabled') return this.nextTitle ? this : null;
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

  function mount(arm = true) {
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
      vi.advanceTimersByTime(arm ? 300 : 0);
    });
    expect(boundary.armed).toBe(arm);
    return { root, next, boundary };
  }

  function touch(root: TestElement, type: string, y: number, target = root, x = 0) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      target: { value: target },
      touches: { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] },
    });
    root.dispatchEvent(event);
    return event;
  }

  it('accepts a new touch at the end without waiting for wheel momentum to settle', async () => {
    const { root, next, boundary } = mount(false);
    root.scrollTop = 300;
    await act(async () => {
      touch(root, 'touchstart', 400);
      root.scrollTop = 400;
      boundary.onScroll();
      expect(touch(root, 'touchmove', 300).defaultPrevented).toBe(false);
      touch(root, 'touchend', 300);
    });
    expect(next).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(50);
      touch(root, 'touchstart', 400);
      expect(touch(root, 'touchmove', 320).defaultPrevented).toBe(true);
      touch(root, 'touchend', 320);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a fresh pull immediately after a short pull', async () => {
    const { root, next } = mount();
    await act(async () => {
      touch(root, 'touchstart', 400);
      touch(root, 'touchmove', 380);
      touch(root, 'touchend', 380);
    });
    expect(next).not.toHaveBeenCalled();
    await act(async () => {
      touch(root, 'touchstart', 400);
      expect(touch(root, 'touchmove', 320).defaultPrevented).toBe(true);
      touch(root, 'touchend', 320);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores a sideways drag on the body at the end and accepts the next upward pull', async () => {
    const { root, next } = mount();
    await act(async () => {
      touch(root, 'touchstart', 400);
      expect(touch(root, 'touchmove', 340, root, 140).defaultPrevented).toBe(false);
      touch(root, 'touchend', 340, root, 140);
    });
    expect(next).not.toHaveBeenCalled();
    await act(async () => {
      touch(root, 'touchstart', 400);
      touch(root, 'touchmove', 320, root, 15);
      touch(root, 'touchend', 320, root, 15);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves native scrolling alone after a touch moves back into the chapter', async () => {
    const { root, next, boundary } = mount();
    await act(async () => {
      touch(root, 'touchstart', 400);
      expect(touch(root, 'touchmove', 440).defaultPrevented).toBe(false);
      root.scrollTop = 360;
      boundary.onScroll();
      expect(touch(root, 'touchmove', 320).defaultPrevented).toBe(false);
      root.scrollTop = 400;
      touch(root, 'touchend', 320);
    });
    expect(next).not.toHaveBeenCalled();
  });

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

  it('accepts an upward swipe on the visible title above the physical end and preserves ordinary taps', async () => {
    const { root, next } = mount(false);
    const title = new TestElement(true, true);
    root.scrollTop = 325;
    await act(async () => {
      touch(root, 'touchstart', 400, title);
      expect(touch(root, 'touchend', 400, title).defaultPrevented).toBe(false);
      touch(root, 'touchstart', 400, title);
      expect(touch(root, 'touchmove', 320, title, 110).defaultPrevented).toBe(false);
      touch(root, 'touchend', 320, title);
    });
    expect(next).not.toHaveBeenCalled();
    await act(async () => {
      touch(root, 'touchstart', 400, title);
      expect(touch(root, 'touchmove', 320, title).defaultPrevented).toBe(true);
      expect(touch(root, 'touchend', 320, title).defaultPrevented).toBe(true);
      touch(root, 'touchend', 320, title);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not turn a chapter for a touch that began on an interactive control', async () => {
    const { root, next } = mount();
    const control = new TestElement(true);
    await act(async () => {
      touch(root, 'touchstart', 400, control);
      expect(touch(root, 'touchmove', 300, control).defaultPrevented).toBe(false);
      touch(root, 'touchend', 300, control);
    });
    expect(next).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      touch(root, 'touchstart', 400, root);
      expect(touch(root, 'touchmove', 300, root).defaultPrevented).toBe(true);
      touch(root, 'touchend', 300, root);
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
