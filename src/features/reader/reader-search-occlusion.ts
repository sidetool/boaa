import { useLayoutEffect, useState, type RefObject } from 'react';

const SEARCH_LAYERS = '.reader-topbar, .reader-mobile-search, .reader-search-results-layer';
export interface SearchLayerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** Coordinates are viewport-relative, including CSS transforms and expanded results. */
export function searchVisibleTop(
  viewport: SearchLayerRect,
  contentTop: number,
  layers: readonly SearchLayerRect[],
): number {
  return layers.reduce(
    (top, layer) =>
      layer.right > viewport.left &&
      layer.left < viewport.right &&
      layer.bottom > viewport.top &&
      layer.top < viewport.bottom &&
      layer.bottom > layer.top
        ? Math.max(top, Math.min(layer.bottom, viewport.bottom))
        : top,
    contentTop,
  );
}
export function readerSearchVisibleTop(root: HTMLElement, contentTop: number): number {
  const screen = root.closest('.reader-screen');
  const layers = [...(screen?.querySelectorAll<HTMLElement>(SEARCH_LAYERS) ?? [])]
    .filter((layer) => {
      const style = window.getComputedStyle(layer);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    })
    .map((layer) => layer.getBoundingClientRect());
  return searchVisibleTop(root.getBoundingClientRect(), contentTop, layers);
}
/** Reserve space only while displaying a search destination, never for ordinary seeks. */
export function useReaderSearchInset(rootRef: RefObject<HTMLElement>, enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) {
      setInset(0);
      return;
    }
    const update = () => {
      const top = root.getBoundingClientRect().top + (parseFloat(window.getComputedStyle(root).paddingTop) || 0);
      setInset(Math.max(0, readerSearchVisibleTop(root, top) - top));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(root);
    const screen = root.closest('.reader-screen');
    for (const layer of screen?.querySelectorAll<HTMLElement>(SEARCH_LAYERS) ?? []) observer?.observe(layer);
    // Mobile search can mount after the destination was placed.
    const mutation =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            for (const layer of screen?.querySelectorAll<HTMLElement>(SEARCH_LAYERS) ?? []) observer?.observe(layer);
            update();
          });
    if (screen)
      mutation?.observe(screen, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden'],
      });
    window.addEventListener('resize', update);
    // Opening/closing details changes height; chrome visibility can change via transforms.
    screen?.addEventListener('toggle', update, true);
    screen?.addEventListener('transitionend', update);
    return () => {
      observer?.disconnect();
      mutation?.disconnect();
      window.removeEventListener('resize', update);
      screen?.removeEventListener('toggle', update, true);
      screen?.removeEventListener('transitionend', update);
    };
  }, [enabled, rootRef]);
  return enabled ? inset : 0;
}
