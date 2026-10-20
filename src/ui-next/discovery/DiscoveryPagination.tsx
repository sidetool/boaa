import { useEffect, useRef } from 'react';
import type { useDiscoveryPages } from '../../features/discovery/useDiscoveryPages';

/** Observe the list's own scroller, including short pages that do not fill it yet. */
export function DiscoveryPagination({ data }: { data: ReturnType<typeof useDiscoveryPages> }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(data.loadMore);
  loadMore.current = data.loadMore;
  const automatic = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !automatic || !data.more || data.busy || data.error) return;
    let requested = false;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || requested || !entries.some((entry) => entry.isIntersecting)) return;
        requested = true;
        loadMore.current();
      },
      { root: node.closest('.un-discover'), rootMargin: '0px 0px 400px 0px' },
    );
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [automatic, data.more, data.busy, data.error, data.pageKey]);

  if (!data.more || data.error) return null;
  return (
    <div ref={sentinel} className="un-discover-more">
      {automatic ? (
        <span role="status">{data.busy ? '불러오는 중…' : '아래로 스크롤하면 더 불러와요.'}</span>
      ) : (
        <button type="button" className="un-btn is-ghost" disabled={data.busy} onClick={data.loadMore}>
          {data.busy ? '불러오는 중…' : '더 불러오기'}
        </button>
      )}
    </div>
  );
}
