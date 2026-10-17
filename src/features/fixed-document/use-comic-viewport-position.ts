import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
export interface ComicViewportPosition {
  page: number;
  fraction: number;
  ratio: number;
}
/** Entry-scoped viewport restoration and precise position capture. */
export function useComicViewportPosition(input: {
  identity: string;
  continuous: boolean;
  page: number;
  ready: boolean;
  viewport: RefObject<HTMLElement>;
  content: RefObject<HTMLElement>;
  initial?: ComicViewportPosition;
  save?: (position: ComicViewportPosition) => void;
  /** Bring an offscreen virtual row back into the loading window during entry restoration. */
  restorePage?: (page: number) => void;
}) {
  // New streamed entries without history start at the top before pages are measured.
  useLayoutEffect(() => {
    if (input.save && !input.initial && input.viewport.current) input.viewport.current.scrollTop = 0;
    // The entry identity owns its initial position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.identity]);
  const callback = useRef(input.save);
  callback.current = input.save;
  const restorePage = useRef(input.restorePage);
  restorePage.current = input.restorePage;
  const updateGeometry = useRef<(() => void) | undefined>();
  const ready = useRef(input.ready);
  ready.current = input.ready;
  useEffect(() => {
    if (!input.continuous && input.ready) callback.current?.({ page: input.page, fraction: 0, ratio: 1.5 });
  }, [input.continuous, input.ready, input.page, input.identity]);
  useEffect(() => {
    const root = input.viewport.current,
      body = input.content.current;
    if (!input.save || !input.continuous || !root || !body) return;
    const save = input.save;
    let restored = !input.initial;
    let restoring = Boolean(input.initial);
    let latest: ComicViewportPosition | undefined;
    let frame = 0,
      timer = 0;
    const capture = () => {
      // Layout/restore-generated scroll events must never replace the durable anchor.
      if (!restored || restoring || !ready.current) return;
      const top = root.getBoundingClientRect().top;
      const row = [...body.querySelectorAll<HTMLElement>('article[data-page-index]')].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      if (
        !row ||
        (!row.querySelector<HTMLImageElement>('img')?.naturalWidth &&
          !row.querySelector<HTMLCanvasElement>('canvas')?.width)
      )
        return;
      const bounds = row.getBoundingClientRect();
      if (bounds.height <= 0 || bounds.width <= 0) return;
      latest = {
        page: Number(row.dataset.pageIndex),
        fraction: Math.max(0, Math.min(0.999999, (top - bounds.top) / bounds.height)),
        ratio: bounds.height / bounds.width,
      };
    };
    const flush = () => {
      if (latest) save(latest);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (restoring && input.initial) {
            const row = body.querySelector<HTMLElement>(`article[data-page-index="${input.initial.page}"]`);
            if (!row) {
              // A resize can move the virtual loading window away from the saved page.
              // Waiting for that page to decode would deadlock: it is no longer requested.
              restorePage.current?.(input.initial.page);
              return;
            }
            // Keep the target in view even while its image is loading. Only decoded
            // geometry completes restoration and permits user input to replace the anchor.
            root.scrollTop +=
              row.getBoundingClientRect().top -
              root.getBoundingClientRect().top +
              input.initial.fraction * row.getBoundingClientRect().height;
            if (
              ready.current &&
              (row.querySelector<HTMLImageElement>('img')?.naturalWidth ||
                row.querySelector<HTMLCanvasElement>('canvas')?.width)
            )
              restored = true;
          }
          capture();
          clearTimeout(timer);
          timer = window.setTimeout(flush, 200);
        });
      });
    };
    updateGeometry.current = update;
    const hide = () => {
      capture();
      flush();
    };
    // Only input after a successful restore transfers ownership to the user.
    // Early toolbar/back input must not validate a placeholder offset; Escape is not scrolling.
    const interacted = () => {
      if (restored && ready.current) restoring = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interacted();
    };
    const scroll = () => {
      // Capture synchronously: back navigation may unmount before the next frame.
      capture();
      flush();
      update();
    };
    const resize = new ResizeObserver(update);
    resize.observe(root);
    resize.observe(body);
    for (const event of ['pointerdown', 'touchstart', 'wheel'])
      window.addEventListener(event, interacted, { capture: true, passive: true });
    window.addEventListener('keydown', keydown);
    root.addEventListener('load', update, true);
    root.addEventListener('scroll', scroll);
    window.addEventListener('pagehide', hide);
    update();
    return () => {
      if (updateGeometry.current === update) updateGeometry.current = undefined;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      flush();
      resize.disconnect();
      for (const event of ['pointerdown', 'touchstart', 'wheel']) window.removeEventListener(event, interacted, true);
      window.removeEventListener('keydown', keydown);
      root.removeEventListener('load', update, true);
      root.removeEventListener('scroll', scroll);
      window.removeEventListener('pagehide', hide);
    };
    // The initial position and save callback belong to this entry, not later scroll renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.identity, input.continuous]);
  // A decoded image can finish before React publishes ready=true. Neither load nor
  // ResizeObserver is guaranteed to fire again, so retry the pending restore/capture.
  useEffect(() => {
    updateGeometry.current?.();
  }, [input.ready, input.page]);
}
