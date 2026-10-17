import type { RefObject } from 'react';
import { focalAnchorScrollDelta, type ViewportFocalAnchor } from './viewport-focal-anchor';

type PendingAnchor = { current: ViewportFocalAnchor | undefined };

/** Preserve the original reading point, but invalidate work scheduled for older geometry. */
export function renewViewportFocalRestore(pending: PendingAnchor, capture: () => ViewportFocalAnchor | undefined) {
  const anchor = pending.current ?? capture();
  pending.current = anchor ? { ...anchor } : undefined;
}

export function scheduleViewportFocalRestore(pending: PendingAnchor, viewportRef: RefObject<HTMLElement>) {
  const anchor = pending.current;
  if (!anchor) return;
  let settleFrame = 0;
  const layoutFrame = window.requestAnimationFrame(() => {
    settleFrame = window.requestAnimationFrame(() => {
      if (pending.current !== anchor) return;
      const viewport = viewportRef.current;
      const page = viewport?.querySelector<HTMLElement>(`[data-page-index="${anchor.pageIndex}"]`);
      if (!viewport || !page) {
        pending.current = undefined;
        return;
      }
      const delta = focalAnchorScrollDelta(anchor, viewport.getBoundingClientRect(), page.getBoundingClientRect());
      viewport.scrollBy({ left: delta.left, top: delta.top });
      pending.current = undefined;
    });
  });
  return () => {
    window.cancelAnimationFrame(layoutFrame);
    if (settleFrame) window.cancelAnimationFrame(settleFrame);
  };
}
