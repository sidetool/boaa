import { Check, MoreHorizontal, RotateCw } from 'lucide-react';
import { useRef, useState, type MouseEvent } from 'react';
import { BookCover } from '../../features/library/BookCover';
import type { LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import {
  importTaskIsActive,
  importTaskStageLabel,
  type ImportTaskView,
} from '../../features/import/import-task-projection';
import type { Novel } from '../../domain/types';
import { cx, Progress } from '../components/primitives';
import type { LibraryProgress } from './contract';

export type TileLayout = 'grid' | 'compact' | 'list' | 'text';

const FORMAT: Record<NonNullable<Novel['format']>, string> = {
  txt: 'TXT',
  markdown: 'MD',
  epub: 'EPUB',
  pdf: 'PDF',
  image_archive: 'COMIC',
};

/** Long press on touch, right click on desktop; a fired long press swallows the following click. */
function useLongPress(onLongPress: () => void, onContext: () => void = onLongPress) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const origin = useRef<{ x: number; y: number }>();
  const fired = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  return {
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(8);
          onLongPress();
        }, 450);
      },
      onPointerMove: (event: React.PointerEvent) => {
        const start = origin.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (event: MouseEvent) => {
        event.preventDefault();
        cancel();
        fired.current = true;
        onContext();
      },
    },
    consumeLongPress: () => {
      const value = fired.current;
      fired.current = false;
      return value;
    },
  };
}

/** Books without artwork get a typographic cover instead of the classic placeholder. */
export function GeneratedCover({ novel, coverClass }: { novel: Novel; coverClass: string }) {
  return (
    <div className={cx('un-cover', coverClass)}>
      <span className="un-cover-fallback" aria-hidden="true">
        {novel.format && <em>{FORMAT[novel.format]}</em>}
        <strong>{novel.title}</strong>
        {novel.author && <small>{novel.author}</small>}
      </span>
    </div>
  );
}

/** Remote artwork with a typographic fallback when the image is missing or fails. */
export function RemoteCover({
  title,
  author,
  url: source,
  className = 'cover-3',
}: {
  title: string;
  author?: string;
  url?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  const url = source && source !== failed ? source : undefined;
  return (
    <div className={cx('un-cover', className)}>
      {url ? (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
        />
      ) : (
        <span className="un-cover-fallback" aria-hidden="true">
          <strong>{title}</strong>
          {author && <small>{author}</small>}
        </span>
      )}
    </div>
  );
}

function ExternalCover({ work }: { work: LibraryExternalWorkView }) {
  return <RemoteCover title={work.title} author={work.author} url={work.thumbnailUrl} />;
}

/** Cover for any library item; shared by tiles and the home hero. */
export function WorkCover({ item }: { item: LibraryWorkItem }) {
  if (item.kind === 'external') return <ExternalCover work={item.work} />;
  const { novel, coverClass } = item.book;
  return novel.coverAssetId ? (
    <BookCover novel={novel} className={cx('un-cover', coverClass)} />
  ) : (
    <GeneratedCover novel={novel} coverClass={coverClass} />
  );
}

function TaskOverlay({ task }: { task: ImportTaskView }) {
  const failed = task.phase === 'failed';
  return (
    <span className={cx('un-tile-task', failed && 'is-failed')}>
      {failed ? <RotateCw size={18} /> : <Progress value={(task.percent ?? 0) / 100} />}
      <small>{failed ? '가져오지 못했어요' : importTaskStageLabel(task)}</small>
    </span>
  );
}

export interface WorkTileProps {
  item: LibraryWorkItem;
  layout: TileLayout;
  progress: LibraryProgress;
  task?: ImportTaskView;
  selecting: boolean;
  selected: boolean;
  activate(): void;
  openMenu(): void;
  /** Starts selection with this work; long press on touch, the corner check on hover. */
  pick?(): void;
}

export function WorkTile({
  item,
  layout,
  progress,
  task,
  selecting,
  selected,
  activate,
  openMenu,
  pick,
}: WorkTileProps) {
  // Long press selects (gallery convention); right click keeps the work menu on desktop.
  const { handlers, consumeLongPress } = useLongPress(
    selecting ? activate : (pick ?? openMenu),
    selecting ? activate : openMenu,
  );
  const busy = Boolean(task && importTaskIsActive(task));
  const title = item.kind === 'book' ? item.book.novel.title : item.work.title;
  const author = item.kind === 'book' ? item.book.novel.author : item.work.author;
  const deleted = item.kind === 'book' ? item.book.novel.deletedAt : item.work.deletedAt;
  const tag =
    item.kind === 'book'
      ? item.book.novel.format && FORMAT[item.book.novel.format]
      : (item.work.sourceLabel ?? '스트리밍');
  const newReleases = item.kind === 'external' ? item.work.newReleaseCount : 0;
  const finished =
    item.kind === 'book'
      ? item.book.isFinished
      : item.work.availableReleaseCount > 0 && (item.work.readReleaseCount ?? 0) >= item.work.availableReleaseCount;
  const isList = layout === 'list' || layout === 'text';

  return (
    <div
      className={cx('un-tile', `is-${layout}`, selected && 'is-selected', busy && 'is-busy', deleted && 'is-deleted')}
    >
      <button
        type="button"
        className="un-tile-open"
        aria-pressed={selecting ? selected : undefined}
        aria-label={selecting ? `${title} 선택` : `${title} 열기`}
        onClick={() => {
          if (consumeLongPress()) return;
          activate();
        }}
        {...handlers}
      >
        {layout !== 'text' && (
          <span className="un-tile-art">
            <WorkCover item={item} />
            {!isList && progress.progress > 0 && <Progress value={progress.progress} className="un-tile-progress" />}
            {newReleases > 0 && !isList && (
              <span className="un-tile-flag is-up" aria-label={`새 회차 ${newReleases}개`}>
                UP<small>{newReleases > 99 ? '99+' : newReleases}</small>
              </span>
            )}
            {finished && !isList && !task && (
              <span className="un-tile-badge" aria-label="완독">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
            {task && !isList && <TaskOverlay task={task} />}
            {selecting && <span className="un-tile-check">{selected && <Check size={16} strokeWidth={3} />}</span>}
          </span>
        )}
        <span className="un-tile-meta">
          <span className="un-tile-title">{title}</span>
          <span className="un-tile-sub">
            {isList && author ? `${author} · ` : ''}
            {task ? (task.phase === 'failed' ? '가져오지 못했어요' : importTaskStageLabel(task)) : progress.subline}
          </span>
          {isList && (
            <span className="un-tile-foot">
              {tag && <span className="un-tag">{tag}</span>}
              {newReleases > 0 && <span className="un-tag is-accent">새 회차 {newReleases}</span>}
              <Progress value={task ? (task.percent ?? 0) / 100 : progress.progress} />
              <small>{progress.progress > 0 ? `${progress.percent}%` : ''}</small>
            </span>
          )}
        </span>
      </button>
      {selecting && isList && (
        <span className="un-tile-check is-list" aria-hidden="true">
          {selected && <Check size={16} strokeWidth={3} />}
        </span>
      )}
      {!selecting && (
        <button type="button" className="un-tile-more" aria-label={`${title} 더보기`} onClick={openMenu}>
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  );
}

export function ImportTaskTile({
  task,
  layout,
  openMenu,
}: {
  task: ImportTaskView;
  layout: TileLayout;
  openMenu(): void;
}) {
  const isList = layout === 'list' || layout === 'text';
  return (
    <div className={cx('un-tile', `is-${layout}`, 'is-busy')}>
      <button type="button" className="un-tile-open" aria-label={`${task.title} 가져오기 상태`} onClick={openMenu}>
        {layout !== 'text' && (
          <span className="un-tile-art">
            <span className="un-cover is-pending">
              <span className="un-cover-fallback" aria-hidden="true">
                <strong>{task.title}</strong>
              </span>
            </span>
            {!isList && <TaskOverlay task={task} />}
          </span>
        )}
        <span className="un-tile-meta">
          <span className="un-tile-title">{task.title}</span>
          <span className="un-tile-sub">
            {task.phase === 'failed' ? '가져오지 못했어요' : importTaskStageLabel(task)}
          </span>
          {isList && (
            <span className="un-tile-foot">
              <Progress value={(task.percent ?? 0) / 100} />
              <small>{task.percent !== undefined ? `${task.percent}%` : ''}</small>
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
