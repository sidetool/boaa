import { useCoverCacheRevision } from '../../external-sources/cover-cache-changes';
/** useDiscoveryCover({ item, session, showCover }) manages visibility-gated cover loading/retries.
 * Returns ref (card element), near, url, failed and onError (image failure handler).
 * Attach ref even when covers are hidden; requests abort when the card leaves the viewport.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ExternalItemSummary } from '../../external-sources/contracts';
import type { DiscoverySession } from './discovery-session';
import { transientSourceFailure } from '../../external-sources/cache-policy';
export function useNear(ref: RefObject<HTMLElement>, once = true) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          if (once) observer.disconnect();
        } else if (!once) setNear(false);
      },
      { rootMargin: '300px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, once]);
  return near;
}
export function useDiscoveryCover({
  item,
  session,
  showCover,
}: {
  item: ExternalItemSummary;
  session: DiscoverySession;
  showCover: boolean;
}) {
  useCoverCacheRevision();
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref, false);
  const cached = item.coverRef ? session.peekCover?.(item.coverRef) : undefined;
  const identity = JSON.stringify(item.coverRef ?? item.key);
  const [resolved, setResolved] = useState<{ identity: string; url?: string }>(() => ({
    identity,
    url: cached ?? item.thumbnailUrl,
  }));
  const setUrl = useCallback((url: string | undefined) => setResolved({ identity, url }), [identity]);
  const url = showCover ? (cached ?? (resolved.identity === identity ? resolved.url : item.thumbnailUrl)) : undefined;
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!near || !showCover) {
      if (item.coverRef && !cached) setUrl(undefined);
      setRetry(0);
      return;
    }
    if (!item.coverRef) return;
    const abort = new AbortController();
    void session
      .cover(item.coverRef, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && value) {
          setUrl(value);
          setFailed(false);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && retry < 2 && transientSourceFailure(error))
          retryTimer.current = setTimeout(() => setRetry((value) => value + 1), 2500 * (retry + 1));
      });
    return () => {
      abort.abort();
      clearTimeout(retryTimer.current);
    };
  }, [item.coverRef, cached, near, session, retry, showCover, setUrl]);
  const onError = () => {
    setFailed(true);
    if (item.coverRef && retry < 1) retryTimer.current = setTimeout(() => setRetry((value) => value + 1), 2500);
  };
  return { ref, near, url, failed, onError };
}
