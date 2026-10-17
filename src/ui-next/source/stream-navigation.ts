import { useEffect, useRef } from 'react';
import type { ExternalSourceNavigationSnapshot } from '../../features/external-sources/useExternalSourceController';

/** Returning to the current detail must keep its loaded catalog and scroll cache intact. */
export function isStreamDetailReturn(
  current: { view: string; source?: ExternalSourceNavigationSnapshot },
  target: { view: string; source?: ExternalSourceNavigationSnapshot; stream?: boolean },
): boolean {
  return (
    current.view === 'library' &&
    target.view === 'library' &&
    !target.stream &&
    Boolean(current.source && target.source) &&
    current.source?.sourceId === target.source?.sourceId &&
    current.source?.localBookId === target.source?.localBookId &&
    JSON.stringify(current.source?.breadcrumbs) === JSON.stringify(target.source?.breadcrumbs)
  );
}

/** Android dispatches the same cancelable Escape before considering app-level back layers. */
export function useSourceStreamEscape(active: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
