import {
  ChevronLeft,
  ChevronRight,
  Compass,
  LayoutGrid,
  Grid3x3,
  Navigation,
  Pin,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExternalItemSummary, ExternalSourceListInput } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../../features/external-sources/useExternalSourceController';
import { SourceFilterControl } from '../../features/external-sources/SourceFilterControl';
import { DiscoveryEditSheet as DiscoveryEditor } from './DiscoveryEditSheet';
import { SourceJumpSheet as SourceQuickJump } from './SourceJumpSheet';
import type { DiscoverySection as Section } from '../../features/discovery/discovery-config';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import { pinnedSource } from '../../features/discovery/discovery-config';
import { useDiscoveryCover } from '../../features/discovery/useDiscoveryCover';
import { useDiscoveryScreenState, type DiscoveryScreenProps } from '../../features/discovery/useDiscoveryScreenState';
import { useDiscoverySection } from '../../features/discovery/useDiscoverySection';
import { useDiscoverySourceView } from '../../features/discovery/useDiscoverySourceView';
import { cx, Sheet } from '../components/primitives';
import './discovery.css';
import '../home/home.css';
import '../library/library.css';

type Open = DiscoveryScreenProps['open'];
type Density = 'grid' | 'compact';

function Poster({
  item,
  session,
  owned,
  showCover = true,
  rank,
  open,
}: {
  item: ExternalItemSummary;
  session: DiscoverySession;
  owned: boolean;
  showCover?: boolean;
  /** Popular lists show large rank numerals, like a store chart. */
  rank?: number;
  open(): void;
}) {
  const cover = useDiscoveryCover({ item, session, showCover });
  const sub = item.author ?? item.subtitle ?? (item.kind === 'folder' ? '폴더 열기' : '');
  return (
    <button
      ref={cover.ref}
      type="button"
      className={cx('un-poster', rank !== undefined && 'has-rank')}
      onClick={open}
      aria-label={`${rank !== undefined ? `${rank}위 ` : ''}${item.title} 상세 보기`}
    >
      {rank !== undefined && (
        <span className="un-poster-rank" aria-hidden="true">
          {rank}
        </span>
      )}
      <span className="un-tile-art">
        <span className="un-cover cover-3">
          {cover.near && cover.url && !cover.failed ? (
            <img src={cover.url} alt="" loading="lazy" decoding="async" draggable={false} onError={cover.onError} />
          ) : (
            <span className="un-cover-fallback" aria-hidden="true">
              <strong>{item.title}</strong>
              {item.author && <small>{item.author}</small>}
            </span>
          )}
        </span>
        {owned && <span className="un-tile-flag is-owned">보관 중</span>}
      </span>
      <span className="un-tile-meta">
        <span className="un-tile-title">{item.title}</span>
        {sub && <span className="un-tile-sub">{sub}</span>}
      </span>
    </button>
  );
}

function SkeletonPosters({ count = 7 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="un-skeleton" aria-hidden="true">
          <span />
          <i />
          <i />
        </span>
      ))}
    </>
  );
}

/** Full catalog for one source: list modes, search, filters and paging. */
function SourceView({
  section,
  source,
  session,
  refresh,
  open,
  owned,
  density,
  controls = true,
  query = '',
}: {
  section: Section;
  source?: ExternalSourceView;
  session: DiscoverySession;
  refresh: number;
  open: Open;
  owned(item: ExternalItemSummary): boolean;
  density: Density;
  controls?: boolean;
  query?: string;
}) {
  const view = useDiscoverySourceView({ section, source, session, refresh, controls, query });
  if (view.unavailable)
    return <p className="un-discover-note">소스를 쓸 수 없어요. 소스 관리에서 연결을 확인해 주세요.</p>;
  const searchable = view.modes.includes('search');
  const searching = Boolean(view.input.query || view.input.filters?.length);
  return (
    <div className="un-source-view" ref={view.root}>
      {controls && (
        <div className="un-source-controls">
          <div className="un-chip-row" role="group" aria-label="작품 목록">
            {view.modes
              .filter((mode) => mode !== 'search')
              .map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cx('un-chip', view.input.browseMode === mode && 'is-active')}
                  aria-pressed={view.input.browseMode === mode}
                  onClick={() => view.changeMode(mode)}
                >
                  {mode === 'popular' ? '인기' : '최신'}
                </button>
              ))}
            {view.fields.length > 0 && searchable && (
              <button
                type="button"
                className={cx('un-chip', view.activeFilters.length > 0 && 'is-active')}
                onClick={() => view.setFiltersOpen(true)}
              >
                <SlidersHorizontal size={15} />
                {view.filterSummary || '필터'}
                {view.activeFilters.length > 2 && <small>외 {view.activeFilters.length - 2}</small>}
              </button>
            )}
          </div>
          {searchable && (
            <form
              className="un-discover-search"
              onSubmit={(event) => {
                event.preventDefault();
                view.apply();
              }}
            >
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="소스 작품 검색"
                placeholder={`${source?.title ?? '소스'}에서 찾기`}
                type="search"
                value={view.draftQuery}
                onChange={(event) => view.setDraftQuery(event.target.value)}
              />
              {searching && (
                <button type="button" className="un-icon-btn is-sm" aria-label="검색 초기화" onClick={view.resetSearch}>
                  <X size={16} />
                </button>
              )}
            </form>
          )}
        </div>
      )}

      {view.data.error && !view.data.hasPage && (
        <p className="un-discover-note" role="status">
          {view.data.error}
          <button type="button" className="un-btn is-text is-sm" onClick={view.data.retry}>
            다시 시도
          </button>
        </p>
      )}
      <div className={cx('un-grid', `is-${density}`, 'un-discover-grid')} aria-busy={view.data.busy}>
        {view.data.items.map((item) => (
          <Poster
            key={JSON.stringify(item.key)}
            item={item}
            session={session}
            owned={owned(item)}
            open={() => open(...view.itemOpenArgs(item))}
          />
        ))}
        {!view.data.hasPage && view.data.busy && <SkeletonPosters count={12} />}
      </div>
      {view.data.hasPage && !view.data.items.length && <p className="un-discover-note">조건에 맞는 작품이 없어요.</p>}
      {view.data.more && !view.data.error && (
        <div className="un-discover-more">
          <button type="button" className="un-btn is-ghost" disabled={view.data.busy} onClick={view.data.loadMore}>
            {view.data.busy ? '불러오는 중…' : '더 불러오기'}
          </button>
        </div>
      )}

      <Sheet
        open={view.filtersOpen}
        onClose={() => view.setFiltersOpen(false)}
        title="필터"
        footer={
          <>
            <button type="button" className="un-btn is-text" onClick={view.resetFilters}>
              조건 초기화
            </button>
            <button
              type="button"
              className="un-btn is-primary"
              onClick={() => {
                view.apply();
                view.setFiltersOpen(false);
              }}
            >
              적용
            </button>
          </>
        }
      >
        <div className="un-filter-fields">
          {view.definitions.map((definition) => (
            <SourceFilterControl
              key={definition.id}
              definition={definition}
              value={view.getFilterValue(definition)}
              setValue={(value) => view.setFilterValue(definition.id, value)}
              compactChoices
            />
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** A horizontally scrolling list from one source; expands into the full catalog in place. */
function SectionRow({
  section,
  source,
  session,
  query,
  refresh,
  positions,
  open,
  owned,
  density,
}: {
  section: Section;
  source?: ExternalSourceView;
  session: DiscoverySession;
  query: string;
  refresh: number;
  positions: Map<string, number>;
  open: Open;
  owned(item: ExternalItemSummary): boolean;
  density: Density;
}) {
  const state = useDiscoverySection({ section, source, session, query, refresh, positions });
  const [edges, setEdges] = useState({ start: true, end: true });
  const page = state.page;
  useEffect(() => {
    const element = state.rail.current;
    if (!element) return;
    const update = () =>
      setEdges({
        start: element.scrollLeft < 8,
        end: element.scrollLeft + element.clientWidth > element.scrollWidth - 8,
      });
    update();
    element.addEventListener('scroll', update, { passive: true });
    return () => element.removeEventListener('scroll', update);
  }, [state.rail, page]);
  const scrollRail = (direction: 1 | -1) =>
    state.rail.current?.scrollBy({ left: direction * state.rail.current.clientWidth * 0.85, behavior: 'smooth' });
  const live = !state.unsupported && !state.unavailable;
  // Unfiltered popular lists read as a chart: top ten with large numerals.
  const ranked = section.mode === 'popular' && !query && !section.filters?.length && density === 'grid';
  const folder = source?.kind === 'cloud_file';

  return (
    <section
      ref={state.ref}
      className={cx('un-row', density === 'compact' && 'is-compact', ranked && 'is-ranked')}
      data-discovery-section={section.id}
      aria-label={state.title}
    >
      <header className="un-row-head">
        <div className="un-discover-row-title">
          {state.eyebrow && <small>{state.eyebrow}</small>}
          <h2>{state.title}</h2>
        </div>
        <div className="un-discover-row-actions">
          {state.candidate && !state.error && (
            <button type="button" className="un-chip is-accent" onClick={state.refreshSection}>
              새 목록 보기
            </button>
          )}
          {state.error && state.refreshSection && (
            <button type="button" className="un-btn is-text is-sm" onClick={state.refreshSection}>
              <RefreshCw size={15} />
              다시 시도
            </button>
          )}
          {source && (live || folder) && (
            <button
              type="button"
              className="un-row-more"
              aria-expanded={folder ? undefined : state.expanded}
              onClick={() =>
                folder ? open(section.sourceId, {}) : state.expanded ? state.collapse() : state.setExpanded(true)
              }
            >
              {folder ? '폴더 보기' : state.expanded ? '접기' : '전체 보기'}
            </button>
          )}
        </div>
      </header>

      {state.expanded && live ? (
        <SourceView
          section={section}
          source={source}
          session={session}
          refresh={refresh}
          open={open}
          owned={owned}
          density={density}
          controls={false}
          query={query}
        />
      ) : state.unsupported ? (
        <p className="un-discover-note">{state.unsupported}</p>
      ) : state.unavailable ? (
        <p className="un-discover-note">소스를 쓸 수 없어요. 소스 관리에서 연결을 확인해 주세요.</p>
      ) : (
        <div className="un-row-viewport">
          <div ref={state.rail} className="un-row-track" aria-busy={state.loading}>
            {page ? (
              page.items
                .slice(0, ranked ? 10 : 20)
                .map((item, index) => (
                  <Poster
                    key={JSON.stringify(item.key)}
                    item={item}
                    session={session}
                    owned={owned(item)}
                    rank={ranked ? index + 1 : undefined}
                    open={() => open(...state.itemOpenArgs(item))}
                  />
                ))
            ) : state.error ? (
              <p className="un-row-note" role="status">
                {state.error}
              </p>
            ) : (
              <SkeletonPosters />
            )}
            {page && !page.items.length && <p className="un-row-note">조건에 맞는 작품이 없어요.</p>}
          </div>
          {!edges.start && (
            <button
              type="button"
              className="un-row-arrow is-prev"
              aria-label="이전"
              tabIndex={-1}
              onClick={() => scrollRail(-1)}
            >
              <ChevronLeft size={26} />
            </button>
          )}
          {!edges.end && (
            <button
              type="button"
              className="un-row-arrow is-next"
              aria-label="다음"
              tabIndex={-1}
              onClick={() => scrollRail(1)}
            >
              <ChevronRight size={26} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default function UiNextDiscoveryScreen(props: DiscoveryScreenProps) {
  const state = useDiscoveryScreenState(props);
  const { sources, discovery, open, library } = props;
  const tabStrip = useRef<HTMLDivElement>(null);
  const density: Density = state.viewMode === 'compact' ? 'compact' : 'grid';

  // Keep the active tab visible when it changes (pinning, quick jump, restore).
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    const active = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !active) return;
    const bounds = strip.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.right > bounds.right) strip.scrollLeft += item.right - bounds.right + 24;
    else if (item.left < bounds.left) strip.scrollLeft += item.left - bounds.left - 24;
  }, [state.selected, state.quickSource, state.tabs.length]);

  const quickTitle = state.quickSource
    ? (sources.sources.find((source) => source.id === state.quickSource)?.title ?? '소스')
    : undefined;
  const sourceTitle = (id: string) => sources.sources.find((source) => source.id === id)?.title ?? '쓸 수 없는 소스';

  return (
    <div ref={state.scroll} className="un-discover">
      <header className="un-discover-head">
        <h1>탐색</h1>
        <div className="un-discover-actions">
          <button
            type="button"
            className="un-icon-btn"
            aria-label={density === 'grid' ? '작은 표지로 보기' : '큰 표지로 보기'}
            onClick={() => state.setViewMode(density === 'grid' ? 'compact' : 'grid')}
          >
            {density === 'grid' ? <Grid3x3 size={20} /> : <LayoutGrid size={20} />}
          </button>
          <button type="button" className="un-icon-btn" aria-label="탐색 목록 새로고침" onClick={state.refreshSections}>
            <RefreshCw size={20} />
          </button>
          <button
            type="button"
            className="un-icon-btn"
            aria-label="소스 빠른 이동"
            aria-haspopup="dialog"
            onClick={() => state.setQuickJump(true)}
          >
            <Navigation size={20} />
          </button>
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            aria-label="탐색 편집"
            onClick={() => state.setEditing(true)}
          >
            <SlidersHorizontal size={16} />
            <span>탐색 편집</span>
          </button>
        </div>
      </header>

      {(state.tabs.length > 0 || state.quickSource) && (
        <div className="un-discover-tabs">
          <div ref={tabStrip} className="un-underline-tabs" role="tablist" aria-label="탐색 분류">
            {state.tabs.map((tab) => {
              const active = !state.quickSource && tab.id === state.tab?.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={cx(active && 'is-active')}
                  onClick={() => state.selectTab(tab.id)}
                >
                  {pinnedSource(tab) && <Pin size={13} className="un-discover-pin" aria-hidden="true" />}
                  {tab.title}
                </button>
              );
            })}
            {state.quickSource && (
              <button
                type="button"
                role="tab"
                aria-selected="true"
                className="is-active un-discover-quick-tab"
                onClick={() => state.setQuickSource(undefined)}
                aria-label={`${quickTitle} 닫기`}
              >
                {quickTitle}
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      {discovery.error && (
        <p className="un-inline-alert un-discover-alert" role="status">
          {discovery.error}
          <button type="button" className="un-btn is-text is-sm" onClick={() => void discovery.refresh()}>
            다시 시도
          </button>
        </p>
      )}
      {state.pinError && (
        <p className="un-inline-alert un-discover-alert" role="status">
          {state.pinError}
        </p>
      )}

      {!state.dedicated && state.rows.length > 0 && (
        <form
          className="un-discover-search is-tab"
          onSubmit={(event) => {
            event.preventDefault();
            state.submitSearch();
          }}
        >
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={state.draftQuery}
            aria-label="탐색 작품 검색"
            placeholder="이 탭에서 작품 찾기"
            onChange={(event) => state.setDraftQuery(event.target.value)}
          />
          {state.sectionSources.length > 1 && (
            <select
              aria-label="검색할 소스"
              value={state.searchSource}
              onChange={(event) => state.setSearchSource(event.target.value)}
            >
              <option value="all">모든 소스</option>
              {state.sectionSources.map((id) => (
                <option key={id} value={id}>
                  {sourceTitle(id)}
                </option>
              ))}
            </select>
          )}
          {state.query && (
            <button type="button" className="un-icon-btn is-sm" aria-label="검색 초기화" onClick={state.resetSearch}>
              <X size={16} />
            </button>
          )}
        </form>
      )}

      {state.dedicated ? (
        <div className="un-discover-dedicated" data-discovery-section={state.dedicated.id}>
          <SourceView
            key={JSON.stringify([state.dedicated, state.session.key(state.dedicated.sourceId, {})])}
            section={state.dedicated}
            source={sources.sources.find((source) => source.id === state.dedicated!.sourceId)}
            session={state.session}
            refresh={state.refresh}
            open={open}
            owned={state.owned}
            density={density}
          />
        </div>
      ) : !state.rows.length ? (
        <section className="un-home-welcome un-discover-empty">
          <span className="un-empty-icon" aria-hidden="true">
            <Compass size={30} />
          </span>
          <h1>나만의 탐색 화면을 만들어 보세요</h1>
          <p>좋아하는 소스의 인기·최신 작품을 줄로 모아 볼 수 있어요.</p>
          <div className="un-home-welcome-actions">
            <button type="button" className="un-btn is-primary is-lg" onClick={() => state.setEditing(true)}>
              소스와 목록 고르기
            </button>
            <button
              type="button"
              className="un-btn is-ghost is-lg"
              onClick={library.actions.header.openExternalSourceSettings}
            >
              소스 관리
            </button>
          </div>
        </section>
      ) : (
        <div className="un-discover-rows">
          {state.rows.map((section) => {
            const source = sources.sources.find((candidate) => candidate.id === section.sourceId);
            return (
              <SectionRow
                key={JSON.stringify([
                  section,
                  state.query,
                  source?.connection.state,
                  source?.connection.accountConnectionId,
                  source?.connection.connectionGeneration,
                ])}
                section={section}
                source={source}
                session={state.session}
                query={state.query}
                refresh={state.refresh}
                positions={state.positions}
                open={open}
                owned={state.owned}
                density={density}
              />
            );
          })}
        </div>
      )}

      {state.editing && (
        <DiscoveryEditor
          config={state.config}
          sources={sources.sources}
          save={discovery.save}
          close={() => state.setEditing(false)}
        />
      )}
      {state.quickJump && (
        <SourceQuickJump
          sources={sources.sources}
          close={() => state.setQuickJump(false)}
          open={(sourceId: string, input: ExternalSourceListInput) => state.openQuick(sourceId, input)}
          error={state.pinError}
          saving={discovery.saving}
          pinned={state.pinned}
          togglePin={state.togglePin}
        />
      )}
    </div>
  );
}
