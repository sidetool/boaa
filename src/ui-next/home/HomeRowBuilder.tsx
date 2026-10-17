import { ChevronDown, ChevronLeft, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { ExternalItemSummary, ExternalSourceFilterChange } from '../../external-sources/contracts';
import type { DiscoverySection } from '../../features/discovery/discovery-config';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import { useDiscoveryCover } from '../../features/discovery/useDiscoveryCover';
import { useDiscoverySourceView } from '../../features/discovery/useDiscoverySourceView';
import type { ExternalSourceView } from '../../features/external-sources/external-source-controller-contract';
import { SourceFilterControl } from '../../features/external-sources/SourceFilterControl';
import { cx } from '../components/primitives';
import type { HomeSourceRowSection } from './contract';
import { normalizeSourceRowSection, sourceRowSummary } from './source-row';

export interface HomeRowBuilderProps {
  readonly source: { readonly id: string; readonly title: string };
  readonly sourceView?: ExternalSourceView;
  readonly session: DiscoverySession;
  /** Present when editing a row that is already on the home screen. */
  readonly initial?: HomeSourceRowSection;
  /** Receives a normalized section (filter signature included); invalid drafts never reach it. */
  onSave(section: HomeSourceRowSection): void;
  onBack(): void;
}

const MODE_LABEL = { popular: '인기', latest: '최신' } as const;

function PreviewPoster({ item, session }: { item: ExternalItemSummary; session: DiscoverySession }) {
  const cover = useDiscoveryCover({ item, session, showCover: true });
  return (
    <button ref={cover.ref} type="button" className="un-row-builder-poster" tabIndex={-1} aria-hidden="true">
      <span className="un-cover cover-3">
        {cover.near && cover.url && !cover.failed ? (
          <img src={cover.url} alt="" loading="lazy" decoding="async" draggable={false} onError={cover.onError} />
        ) : (
          <span className="un-cover-fallback">
            <strong>{item.title}</strong>
          </span>
        )}
      </span>
      <span className="un-row-builder-poster-title">{item.title}</span>
    </button>
  );
}

/**
 * ui-next 새 줄 만들기: one source, a list (인기/최신) and optional filters, with a live preview of what the
 * row will show. The same screen edits an existing source row.
 */
export function HomeRowBuilder({ source, sourceView, session, initial, onSave, onBack }: HomeRowBuilderProps) {
  const [section] = useState<DiscoverySection>(() => ({
    id: `home-row-builder:${source.id}:${initial?.title ?? 'new'}`,
    sourceId: source.id,
    title: initial?.title ?? '',
    mode: initial?.mode ?? 'popular',
    filters: initial?.filters,
    parentRef: initial?.parentRef,
  }));
  const view = useDiscoverySourceView({
    section,
    source: sourceView,
    session,
    refresh: 0,
    controls: true,
    purpose: 'row-builder',
  });
  const [filtersOpen, setFiltersOpen] = useState(Boolean(initial?.filters?.length));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [titleEdited, setTitleEdited] = useState(Boolean(initial));

  const baseMode: 'popular' | 'latest' =
    view.input.browseMode === 'latest' ? 'latest' : view.input.browseMode === 'popular' ? 'popular' : section.mode;
  // Filters picked but not yet previewed still count: the saved row is what the fields say.
  const pending = Object.keys(view.values).length > 0;
  const chosen: readonly ExternalSourceFilterChange[] | undefined = pending
    ? view.fields.map((field) => ({
        position: field.position,
        groupPosition: field.groupPosition,
        value: (view.getFilterValue(field) ?? field.defaultValue) as ExternalSourceFilterChange['value'],
      }))
    : view.input.browseMode === 'search'
      ? view.input.filters
      : undefined;
  const filtered = Boolean(
    chosen?.some((change) => {
      const field = view.fields.find(
        (candidate) => candidate.position === change.position && candidate.groupPosition === change.groupPosition,
      );
      return field && 'defaultValue' in field && JSON.stringify(field.defaultValue) !== JSON.stringify(change.value);
    }),
  );
  const draft = {
    sourceId: source.id,
    mode: baseMode,
    filters: filtered && chosen ? [...chosen] : undefined,
    parentRef: initial?.parentRef,
  };
  // Same wording as the editor list: "인기 · 월요일 · 무협".
  const summary = sourceRowSummary(draft, view.definitions);
  const autoTitle = `${source.title} · ${summary}`;
  const shownTitle = titleEdited ? title : autoTitle;
  const filterable = view.fields.length > 0 && view.modes.includes('search');
  const unavailable = view.unavailable;

  return (
    <div className="un-row-builder">
      <button type="button" className="un-btn is-text un-home-editor-back" onClick={onBack}>
        <ChevronLeft size={18} />
        {initial ? '편집으로' : '줄 추가로'}
      </button>

      <header className="un-row-builder-head">
        <span className="un-row-builder-avatar" aria-hidden="true">
          {source.title.slice(0, 1)}
        </span>
        <div>
          <small>소스 줄</small>
          <h3>{source.title}</h3>
        </div>
      </header>

      {unavailable ? (
        <p className="un-home-editor-hint">소스를 쓸 수 없어요. 소스 관리에서 연결을 확인해 주세요.</p>
      ) : (
        <>
          <section className="un-row-builder-block" aria-label="목록">
            <h4>목록</h4>
            <div className="un-row-builder-modes" role="radiogroup" aria-label="목록">
              {view.modes
                .filter((mode): mode is 'popular' | 'latest' => mode === 'popular' || mode === 'latest')
                .map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={baseMode === mode}
                    className={cx('un-chip', baseMode === mode && 'is-active')}
                    onClick={() => view.changeMode(mode)}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                ))}
            </div>
          </section>

          {filterable && (
            <section className={cx('un-row-builder-block un-row-builder-filters', filtersOpen && 'is-open')}>
              <button
                type="button"
                className="un-row-builder-fold"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal size={17} aria-hidden="true" />
                <span>
                  필터
                  {filtered && view.filterSummary && <em>{view.filterSummary}</em>}
                </span>
                <ChevronDown size={18} aria-hidden="true" />
              </button>
              {filtersOpen && (
                <div className="un-row-builder-filter-body">
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
                  <div className="un-row-builder-filter-actions">
                    <button
                      type="button"
                      className="un-btn is-text is-sm"
                      onClick={() => {
                        view.resetFilters();
                        view.changeMode(section.mode);
                      }}
                    >
                      <RotateCcw size={15} />
                      필터 없이
                    </button>
                    <button type="button" className="un-btn is-ghost is-sm" onClick={view.apply}>
                      적용해서 미리보기
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="un-row-builder-block" aria-label="미리보기">
            <h4>미리보기</h4>
            <div className="un-row-builder-preview" aria-busy={view.data.busy}>
              {view.data.items.slice(0, 8).map((item) => (
                <PreviewPoster key={JSON.stringify(item.key)} item={item} session={session} />
              ))}
              {!view.data.hasPage &&
                view.data.busy &&
                Array.from({ length: 5 }, (_, index) => (
                  <span key={index} className="un-row-builder-poster is-skeleton" aria-hidden="true">
                    <span className="un-cover cover-3" />
                  </span>
                ))}
            </div>
            {view.data.hasPage && !view.data.items.length && (
              <p className="un-home-editor-hint">조건에 맞는 작품이 없어요. 필터를 바꿔 보세요.</p>
            )}
            {view.data.error && !view.data.hasPage && (
              <p className="un-home-editor-hint">
                미리보기를 불러오지 못했어요.{' '}
                <button type="button" className="un-btn is-text is-sm" onClick={view.data.retry}>
                  다시 시도
                </button>
              </p>
            )}
          </section>

          <label className="un-row-builder-block un-row-builder-name">
            <h4>줄 이름</h4>
            <input
              value={shownTitle}
              maxLength={60}
              onChange={(event) => {
                setTitleEdited(true);
                setTitle(event.target.value);
              }}
              onBlur={() => {
                // Clearing the name hands it back to the automatic one.
                if (!title.trim()) setTitleEdited(false);
              }}
            />
          </label>

          <div className="un-row-builder-save">
            <button
              type="button"
              className="un-btn is-primary is-lg"
              onClick={() => {
                const saved = normalizeSourceRowSection(
                  { ...draft, title: shownTitle.trim() || autoTitle, summary },
                  view.definitions,
                );
                if (saved) onSave(saved);
              }}
            >
              {!initial && <Plus size={18} />}
              {initial ? '저장' : '홈에 추가'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
