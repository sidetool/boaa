import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComicViewportPosition, type ComicViewportPosition } from './use-comic-viewport-position';

let resize: () => void;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
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
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness(initial: ComicViewportPosition | undefined = { page: 1, fraction: 0.42, ratio: 5 }, count = 3) {
  const save = vi.fn();
  const viewport = Object.assign(new EventTarget(), {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
  });
  const rows = Array.from({ length: count }, (_, page) => {
    const image = { naturalWidth: 200 };
    const geometry = { start: page * 1000, height: 1000 };
    return {
      image,
      geometry,
      dataset: { pageIndex: String(page) },
      querySelector: () => image,
      getBoundingClientRect: () => ({
        top: geometry.start - viewport.scrollTop,
        bottom: geometry.start + geometry.height - viewport.scrollTop,
        height: geometry.height,
        width: 200,
      }),
    };
  });
  const body = {
    querySelectorAll: () => rows,
    querySelector: (selector: string) => rows[Number(selector.match(/"(\d+)"/)?.[1])],
  };
  const input: Parameters<typeof useComicViewportPosition>[0] = {
    identity: 'episode-one',
    continuous: true,
    page: 1,
    ready: true,
    viewport: { current: viewport as unknown as HTMLElement },
    content: { current: body as unknown as HTMLElement },
    initial,
    save,
  };
  function Harness() {
    useComicViewportPosition(input);
    return null;
  }
  const mount = () =>
    act(() => {
      renderer = create(<Harness />);
    });
  const unmount = () =>
    act(() => {
      renderer!.unmount();
      renderer = undefined;
    });
  mount();
  return {
    input,
    rows,
    viewport,
    save,
    mount,
    unmount,
    render: () => act(() => renderer!.update(<Harness />)),
    settle: () =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      }),
    scroll: (top: number) => {
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event('scroll'));
    },
  };
}

describe('stream comic resume ownership', () => {
  it('does not let toolbar input or early reader input replace a still-loading anchor', async () => {
    const h = harness();
    h.rows[1]!.image.naturalWidth = 0;
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('touchstart'));
    await h.settle();
    expect(h.save).not.toHaveBeenCalled();
    h.rows[1]!.image.naturalWidth = 200;
    h.viewport.dispatchEvent(new Event('load'));
    await h.settle();
    expect(h.viewport.scrollTop).toBe(1420);
    expect(h.save).not.toHaveBeenCalled();
    h.unmount();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('preserves the original anchor across geometry changes and repeated no-scroll resumes', async () => {
    const h = harness();
    for (let cycle = 0; cycle < 3; cycle++) {
      await h.settle();
      expect(h.viewport.scrollTop).toBe(1420);
      h.rows[1]!.geometry.height = 2000;
      resize();
      await h.settle();
      expect(h.viewport.scrollTop).toBe(1840);
      window.dispatchEvent(new Event('pagehide'));
      h.unmount();
      expect(h.save).not.toHaveBeenCalled();
      h.rows[1]!.geometry.height = 1000;
      h.mount();
    }
  });

  it('ignores Escape but lets reading navigation keys release a restored anchor', async () => {
    const h = harness();
    await h.settle();
    window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    h.rows[1]!.geometry.height = 2000;
    resize();
    await h.settle();
    expect(h.viewport.scrollTop).toBe(1840);
    expect(h.save).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'PageDown' }));
    h.scroll(2000);
    await h.settle();
    expect(h.save).toHaveBeenLastCalledWith({ page: 1, fraction: 0.5, ratio: 10 });
  });

  it('captures a reader scroll before the next frame so immediate back saves the last position', async () => {
    const h = harness();
    await h.settle();
    window.dispatchEvent(new Event('wheel'));
    h.scroll(1730);
    h.unmount();
    expect(h.save).toHaveBeenLastCalledWith({ page: 1, fraction: 0.73, ratio: 5 });
  });

  it('keeps the entry in view without saving while the current document is not ready', async () => {
    const h = harness();
    h.input.ready = false;
    h.render();
    window.dispatchEvent(new Event('wheel'));
    await h.settle();
    expect(h.viewport.scrollTop).toBe(1420);
    expect(h.save).not.toHaveBeenCalled();
    h.input.ready = true;
    h.render();
    await h.settle();
    expect(h.viewport.scrollTop).toBe(1420);
  });

  it('restores saved page 49 after layout drifts to page 69 before ready is published', async () => {
    const h = harness({ page: 48, fraction: 0, ratio: 5 }, 91);
    h.input.ready = false;
    h.render();
    h.scroll(68_000);
    await h.settle();
    expect(h.viewport.scrollTop).toBe(48_000);
    h.input.ready = true;
    h.render();
    await h.settle();
    expect(h.viewport.scrollTop).toBe(48_000);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('requests the saved page when virtual scrolling evicts its unloaded row after a resize', async () => {
    const h = harness({ page: 49, fraction: 0, ratio: 5 }, 91);
    const restorePage = vi.fn();
    const body = h.input.content.current!;
    const query = body.querySelector;
    body.querySelector = vi.fn(() => null);
    h.input.ready = false;
    h.input.page = 64;
    h.input.restorePage = restorePage;
    h.render();
    h.scroll(64_000);
    await h.settle();
    expect(restorePage).toHaveBeenCalledWith(49);
    expect(h.save).not.toHaveBeenCalled();
    body.querySelector = query;
    h.rows[49]!.image.naturalWidth = 0;
    h.input.page = 49;
    h.render();
    await h.settle();
    expect(h.viewport.scrollTop).toBe(49_000);
    expect(h.save).not.toHaveBeenCalled();
    h.rows[49]!.image.naturalWidth = 200;
    h.input.ready = true;
    h.render();
    await h.settle();
    expect(h.viewport.scrollTop).toBe(49_000);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('replaces an old page 69 resume with page 49 when decoding finishes after the last scroll', async () => {
    const h = harness({ page: 68, fraction: 0, ratio: 5 }, 83);
    await h.settle();
    window.dispatchEvent(new Event('pointerdown'));
    h.input.ready = false;
    h.render();
    h.scroll(48_430);
    await h.settle();
    expect(h.save).not.toHaveBeenCalled();
    h.input.ready = true;
    h.render();
    await h.settle();
    expect(h.save).toHaveBeenLastCalledWith({ page: 48, fraction: 0.43, ratio: 5 });
  });

  it('keeps saving continuous entries without history and ignores undecoded pages', async () => {
    const h = harness();
    h.unmount();
    h.input.initial = undefined;
    h.mount();
    await h.settle();
    expect(h.save).toHaveBeenLastCalledWith({ page: 0, fraction: 0, ratio: 5 });
    h.rows[1]!.image.naturalWidth = 0;
    h.scroll(1450);
    await h.settle();
    expect(h.save).not.toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    h.rows[1]!.image.naturalWidth = 200;
    h.viewport.dispatchEvent(new Event('load'));
    await h.settle();
    expect(h.save).toHaveBeenLastCalledWith({ page: 1, fraction: 0.45, ratio: 5 });
  });

  it('keeps discrete page persistence unchanged', async () => {
    const h = harness();
    h.input.continuous = false;
    h.input.page = 2;
    h.render();
    expect(h.save).toHaveBeenLastCalledWith({ page: 2, fraction: 0, ratio: 1.5 });
  });
});
