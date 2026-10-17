import { BookOpen, ChevronLeft, ChevronRight, Compass, FileUp, Info, Pencil, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useNavigationScroll } from '../../features/navigation/navigation-view-state';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import { ActionList, cx, Progress, Sheet, type ActionEntry } from '../components/primitives';
import type { LibraryAction } from '../library/contract';
import { WorkCover, WorkTile } from '../library/WorkTile';
import type { HomeHeroItem, HomeRowItem, HomeRowView, UiNextHomeScreenProps } from './contract';
import { HomeEditor } from './HomeEditor';
import { DiscoveryCard, HomeRow, RowSkeleton } from './rows';
import './home.css';
import '../library/library.css';

function itemTitle(item: LibraryWorkItem) {
  return item.kind === 'book' ? item.book.novel.title : item.work.title;
}

function itemAuthor(item: LibraryWorkItem) {
  return item.kind === 'book' ? item.book.novel.author : item.work.author;
}

/** Index of the card nearest the start edge, tracked from native scroll. */
function useScrollIndex(track: React.RefObject<HTMLElement>, count: number) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const update = () => {
      const first = element.firstElementChild as HTMLElement | null;
      const step = first ? first.offsetWidth + parseFloat(getComputedStyle(element).columnGap || '0') : 1;
      setIndex(Math.max(0, Math.min(count - 1, Math.round(element.scrollLeft / (step || 1)))));
    };
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [track, count]);
  return index;
}

function scrollToCard(track: HTMLElement | null, index: number) {
  const card = track?.children[index] as HTMLElement | undefined;
  if (!track || !card) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  track.scrollTo({
    left: card.offsetLeft - track.offsetLeft - (parseFloat(getComputedStyle(track).scrollPaddingLeft) || 0),
    behavior: reduce ? 'auto' : 'smooth',
  });
}

function ContinueCard({ hero }: { hero: HomeHeroItem }) {
  const title = itemTitle(hero.item);
  const author = itemAuthor(hero.item);
  const fresh = hero.reason === 'new';
  return (
    <article className="un-continue-card" aria-label={title}>
      <div className="un-continue-bg" aria-hidden="true">
        <WorkCover item={hero.item} />
      </div>
      <button
        type="button"
        className="un-continue-cover"
        aria-label={`${title} 작품 정보`}
        onClick={() => void hero.openDetail()}
      >
        <WorkCover item={hero.item} />
      </button>
      <div className="un-continue-body">
        <span className={cx('un-continue-eyebrow', fresh && 'is-new')}>
          {fresh ? 'NEW' : hero.lastReadLabel || '이어 읽기'}
        </span>
        <h3>{title}</h3>
        <p className="un-continue-meta">{[author, ...hero.tags].filter(Boolean).join(' · ')}</p>
        {!fresh && (
          <div className="un-continue-progress">
            <span>{hero.positionLabel}</span>
            <Progress value={hero.progress.progress} label={`${title} 진행률`} />
            <small>{hero.progress.percent}%</small>
          </div>
        )}
        <div className="un-continue-actions">
          <button type="button" className="un-btn is-primary is-sm" onClick={() => void hero.resume()}>
            <BookOpen size={16} />
            {hero.resumeLabel}
          </button>
          <button
            type="button"
            className="un-icon-btn is-sm un-continue-info"
            aria-label="작품 정보"
            onClick={() => void hero.openDetail()}
          >
            <Info size={18} />
          </button>
        </div>
      </div>
    </article>
  );
}

/** Recently read works as compact cards. Moves only when the reader swipes, scrolls or taps — never on its own. */
function HomeHero({ items }: { items: readonly HomeHeroItem[] }) {
  const track = useRef<HTMLDivElement>(null);
  const index = useScrollIndex(track, items.length);
  const many = items.length > 1;
  // Streamed works join a moment after local books. Snap keeps the old first card in view, which hid the
  // newest work off-screen; until the reader touches the row, a new front card brings the row back to it.
  const touched = useRef(false);
  const first = items[0]?.item.key;
  useLayoutEffect(() => {
    const element = track.current;
    if (element && !touched.current && element.scrollLeft !== 0) element.scrollTo({ left: 0, behavior: 'instant' });
  }, [first]);
  const touch = () => {
    touched.current = true;
  };
  // Arrows and dots count as touching the row, so a late front card never undoes where the reader went.
  const go = (to: number) => {
    touch();
    scrollToCard(track.current, to);
  };
  const label = items[0]?.reason === 'new' ? '새로 들어온 작품' : '이어 읽기';
  return (
    <section className="un-row un-continue" aria-roledescription="carousel" aria-label={label}>
      <header className="un-row-head">
        <h2>{label}</h2>
      </header>
      <div className="un-row-viewport">
        <div
          ref={track}
          className="un-continue-track"
          tabIndex={many ? 0 : undefined}
          onPointerDown={touch}
          onWheel={touch}
          onKeyDown={(event) => {
            touch();
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            scrollToCard(
              track.current,
              Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))),
            );
          }}
        >
          {items.map((hero) => (
            <ContinueCard key={hero.item.key} hero={hero} />
          ))}
        </div>
        {many && index > 0 && (
          <button type="button" className="un-row-arrow is-prev" aria-label="이전 작품" onClick={() => go(index - 1)}>
            <ChevronLeft size={26} />
          </button>
        )}
        {many && index < items.length - 1 && (
          <button type="button" className="un-row-arrow is-next" aria-label="다음 작품" onClick={() => go(index + 1)}>
            <ChevronRight size={26} />
          </button>
        )}
      </div>
      {many && (
        <div className="un-hero-dots" role="tablist" aria-label={`${label} 작품`}>
          {items.map((hero, i) => (
            <button
              key={hero.item.key}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`${i + 1}번째 · ${itemTitle(hero.item)}`}
              className={cx(i === index && 'is-active')}
              onClick={() => go(i)}
            >
              <span />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyHome({ adapter }: Pick<UiNextHomeScreenProps, 'adapter'>) {
  return (
    <section className="un-home-welcome">
      <span className="un-home-welcome-art" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <h1>읽을 작품을 넣어 볼까요?</h1>
      <p>텍스트·EPUB·PDF·만화 파일을 가져오면 여기서 이어 읽을 수 있어요.</p>
      <div className="un-home-welcome-actions">
        <button type="button" className="un-btn is-primary is-lg" onClick={adapter.importFiles}>
          <FileUp size={20} />
          파일 가져오기
        </button>
        {adapter.openDiscovery && (
          <button type="button" className="un-btn is-ghost is-lg" onClick={adapter.openDiscovery}>
            <Compass size={20} />
            작품 탐색
          </button>
        )}
      </div>
      {adapter.addSamples && (
        <button type="button" className="un-btn is-text" onClick={adapter.addSamples}>
          <Sparkles size={16} />
          샘플 작품 넣어 보기
        </button>
      )}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="un-home-skeleton" aria-hidden="true">
      <div className="un-hero-skeleton">
        <span />
        <div>
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="un-row">
        <div className="un-row-head">
          <i className="un-skeleton-line" />
        </div>
        <div className="un-row-track">
          <RowSkeleton />
        </div>
      </div>
    </div>
  );
}

type SheetState = { kind: 'item'; title: string; actions: readonly LibraryAction[] } | { kind: 'edit' } | null;

export function UiNextHomeScreen({ adapter }: UiNextHomeScreenProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = () => setSheet(null);
  useNavigationScroll(scrollRef, 'ui-next-home', adapter.status === 'ready');

  const rows = adapter.rows.filter((row) => row.status !== 'ready' || row.items.length > 0);
  const empty = adapter.status === 'ready' && adapter.hero.length === 0 && rows.length === 0;
  const { library } = adapter;

  const openItemMenu = (item: LibraryWorkItem) =>
    setSheet({
      kind: 'item',
      title: itemTitle(item),
      actions: item.kind === 'book' ? library.bookMenu(item.book) : library.externalMenu(item.work),
    });

  const renderItem = (row: HomeRowView, entry: HomeRowItem, index: number) => {
    if (entry.kind === 'discovery')
      return <DiscoveryCard key={entry.key} work={entry.work} ranked={row.ranked} rank={index + 1} />;
    const { item } = entry;
    return (
      <WorkTile
        key={entry.key}
        item={item}
        layout="grid"
        progress={item.kind === 'book' ? library.bookProgress(item.book) : library.externalProgress(item.work)}
        task={item.kind === 'book' ? library.taskForBook(item.book.novel.id) : library.taskForExternal(item.work.id)}
        selecting={false}
        selected={false}
        activate={() => void library.activate(item)}
        openMenu={() => openItemMenu(item)}
      />
    );
  };

  return (
    <main ref={scrollRef} className="un-home" aria-busy={adapter.status === 'loading'}>
      {adapter.status === 'loading' ? (
        <HomeSkeleton />
      ) : adapter.status === 'failed' ? (
        <div className="un-empty">
          <b>서재를 불러오지 못했어요</b>
          <p>잠시 뒤 다시 열어 주세요.</p>
        </div>
      ) : empty ? (
        <EmptyHome adapter={adapter} />
      ) : (
        <>
          <h1 className="un-visually-hidden">홈</h1>
          {adapter.hero.length > 0 && <HomeHero items={adapter.hero} />}
          <div className="un-home-rows">
            {rows.map((row) => (
              <HomeRow key={row.config.id} row={row}>
                {row.status === 'loading' ? (
                  <RowSkeleton />
                ) : row.status === 'failed' ? (
                  <p className="un-row-note" role="status">
                    {row.error ?? '목록을 불러오지 못했어요.'}
                    {row.retry && (
                      <button type="button" className="un-btn is-text is-sm" onClick={row.retry}>
                        다시 시도
                      </button>
                    )}
                  </p>
                ) : (
                  row.items.map((entry, index) => renderItem(row, entry, index))
                )}
              </HomeRow>
            ))}
          </div>
        </>
      )}

      {adapter.status === 'ready' && !empty && (
        <div className="un-home-edit">
          <button type="button" className="un-btn is-ghost" onClick={() => setSheet({ kind: 'edit' })}>
            <Pencil size={16} />홈 화면 편집
          </button>
        </div>
      )}

      <Sheet open={sheet?.kind === 'item'} onClose={close} title={sheet?.kind === 'item' ? sheet.title : undefined}>
        {sheet?.kind === 'item' && (
          <ActionList
            onDone={close}
            actions={sheet.actions.flatMap<ActionEntry>((action, index) =>
              action.danger && index > 0 && !sheet.actions[index - 1].danger ? ['divider', action] : [action],
            )}
          />
        )}
      </Sheet>
      <Sheet open={sheet?.kind === 'edit'} onClose={close} title="홈 화면 편집">
        <HomeEditor adapter={adapter} />
      </Sheet>
    </main>
  );
}
