import { useTranslatedTitle } from '../../features/translation/use-translated-title';
import { ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../components/primitives';
import { RemoteCover } from '../library/WorkTile';
import type { HomeDiscoveryItem, HomeRowView } from './contract';
import { useRowRefresh } from './use-row-refresh';

/** Calls back once when the element comes within a screen of the viewport. */
export function useNearOnce(ref: React.RefObject<HTMLElement>, onNear?: () => void) {
  const callback = useRef(onNear);
  callback.current = onNear;
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      callback.current?.();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setNear(true);
        callback.current?.();
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** Poster for a source work that is not opened yet: cover loads near the viewport, owned works are flagged. */
export function DiscoveryCard({
  work,
  ranked,
  rank = 0,
}: {
  work: HomeDiscoveryItem;
  ranked?: boolean;
  rank?: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearOnce(ref);
  const title = useTranslatedTitle(work.title, near && work.translateTitle !== false);
  const [cover, setCover] = useState(work.thumbnailUrl);
  const coverLoader = useRef(work.loadCover);
  coverLoader.current = work.loadCover;
  const hasCoverLoader = Boolean(work.loadCover);
  useEffect(() => {
    setCover(work.thumbnailUrl);
    if (!near || !coverLoader.current) return;
    const abort = new AbortController();
    coverLoader
      .current(abort.signal)
      .then((url) => {
        if (!abort.signal.aborted && url) setCover(url);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [near, work.id, work.coverKey, work.thumbnailUrl, hasCoverLoader]);
  return (
    <button
      ref={ref}
      type="button"
      className={cx('un-poster', ranked && 'has-rank')}
      aria-label={`${title} ${work.actionLabel ?? '상세 보기'}`}
      onClick={() => void work.open()}
    >
      {ranked && (
        <span className={cx('un-poster-rank', rank >= 10 && 'is-wide')} aria-hidden="true">
          {rank}
        </span>
      )}
      <span className="un-tile-art">
        <RemoteCover title={title} author={work.author} url={near ? cover : undefined} />
        {work.owned ? (
          <span className="un-tile-flag is-owned">보관 중</span>
        ) : (
          work.badge && <span className="un-tile-flag">{work.badge}</span>
        )}
      </span>
      <span className="un-tile-meta">
        <span className="un-tile-title" title={title !== work.title ? work.title : undefined}>
          {title}
        </span>
        {(work.subline ?? work.author) && <span className="un-tile-sub">{work.subline ?? work.author}</span>}
      </span>
    </button>
  );
}

export function RowSkeleton() {
  return (
    <>
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="un-skeleton" aria-hidden="true">
          <span />
          <i />
          <i />
        </span>
      ))}
    </>
  );
}

/**
 * Sideways list with edge arrows for pointer users; touch scrolls natively. `count` re-measures the edges.
 * `startKey` names the first item: works that arrive later can land ahead of the card snap is holding, which
 * slid the row open mid-way. Until the reader moves the row, a new first item brings it back to the start.
 */
export function RowRail({
  children,
  busy,
  count,
  startKey,
}: {
  children: ReactNode;
  busy?: boolean;
  count: number;
  startKey?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  useLayoutEffect(() => {
    const element = track.current;
    if (element && !touched.current && element.scrollLeft !== 0) element.scrollTo({ left: 0, behavior: 'instant' });
  }, [startKey]);
  const [edges, setEdges] = useState({ start: true, end: true });
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const update = () =>
      setEdges({
        start: element.scrollLeft < 8,
        end: element.scrollLeft + element.clientWidth > element.scrollWidth - 8,
      });
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [count, busy]);
  const page = (direction: 1 | -1) => {
    const element = track.current;
    if (!element) return;
    touch();
    element.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' });
  };
  return (
    <div className="un-row-viewport">
      <div
        ref={track}
        className="un-row-track"
        aria-busy={busy}
        onPointerDown={touch}
        onWheel={touch}
        onKeyDown={touch}
      >
        {children}
      </div>
      {!edges.start && (
        <button type="button" className="un-row-arrow is-prev" aria-label="이전" tabIndex={-1} onClick={() => page(-1)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {!edges.end && (
        <button type="button" className="un-row-arrow is-next" aria-label="다음" tabIndex={-1} onClick={() => page(1)}>
          <ChevronRight size={26} />
        </button>
      )}
    </div>
  );
}

const two = (value: number) => String(value).padStart(2, '0');

/** "오늘 09:30", "어제 21:05", "10월 3일 14:00": short enough to sit under a row title. */
export function rowUpdatedLabel(timestamp: number, now = Date.now()) {
  const date = new Date(timestamp);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return `오늘 ${time}`;
  if (days === 1) return `어제 ${time}`;
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}년 `;
  return `${year}${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
}

function RowMeta({ row }: { row: HomeRowView }) {
  const dated = row.updatedAt !== undefined && Number.isFinite(row.updatedAt);
  const ready = row.status === 'ready';
  if (!dated && !(ready && (row.error || row.retry))) return null;
  const label = row.error ? '다시 시도' : row.refreshing ? '새로고침 중' : '새로고침';
  return (
    <div className="un-row-meta">
      {dated && (
        <time dateTime={new Date(row.updatedAt!).toISOString()}>
          {rowUpdatedLabel(row.updatedAt!)} 기준{row.stale ? ' · 이전 목록' : ''}
        </time>
      )}
      {ready && row.error && (
        <span className="un-row-meta-error" role="status">
          {row.error}
        </span>
      )}
      {ready && row.retry && (
        <button
          type="button"
          className={cx('un-row-refresh', row.refreshing && 'is-busy')}
          onClick={row.retry}
          disabled={row.refreshing}
        >
          <RotateCw size={13} aria-hidden="true" />
          {label}
        </button>
      )}
    </div>
  );
}

export function HomeRow({ row, children }: { row: HomeRowView; children: ReactNode }) {
  const section = useRef<HTMLElement>(null);
  const near = useNearOnce(section);
  useRowRefresh(row, near);
  return (
    <section ref={section} className={cx('un-row', row.ranked && 'is-ranked')} aria-label={row.title}>
      <header className="un-row-head">
        {row.eyebrow && <small className="un-row-eyebrow">{row.eyebrow}</small>}
        <h2>
          {row.openAll ? (
            <button type="button" onClick={row.openAll}>
              {row.title}
              <ChevronRight size={20} />
            </button>
          ) : (
            row.title
          )}
        </h2>
        {row.openAll && (
          <button type="button" className="un-row-more" onClick={row.openAll}>
            전체 보기
          </button>
        )}
        <RowMeta row={row} />
      </header>
      <RowRail busy={row.status === 'loading'} count={row.items.length} startKey={row.items[0]?.key}>
        {children}
      </RowRail>
    </section>
  );
}
