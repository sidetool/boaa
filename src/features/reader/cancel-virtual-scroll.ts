import type { Virtualizer } from '@tanstack/react-virtual';

/**
 * TanStack virtual-core 3.17.3 has no cancel API. scrollToOffset creates another
 * reconciliation job, so it cannot release control to a native gesture.
 * Keep this version-sensitive access here and exercise it against the actual
 * library in cancel-virtual-scroll.test.ts. Do not disconnect its observers or
 * write the browser's scroll position when retiring a programmatic target.
 */
export function cancelVirtualScroll<T extends Element>(instance: Virtualizer<T, Element> | undefined): void {
  if (!instance) return;
  const pending = instance as unknown as {
    scrollState: unknown;
    rafId: number | null;
    _intendedScrollOffset: number | null;
  };
  pending.scrollState = null;
  if (pending.rafId != null) instance.targetWindow?.cancelAnimationFrame(pending.rafId);
  pending.rafId = null;
  pending._intendedScrollOffset = null;
}
