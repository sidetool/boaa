import { ChevronLeft, ChevronRight, History, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import { ActionList, Sheet, type ActionEntry } from '../components/primitives';
import { DiscoveryCard, RowRail } from '../home/rows';
import { WorkTile } from '../library/WorkTile';
import type { UiNextSearchScreenProps, UiNextSearchSourceGroup } from './contract';
import '../home/home.css';
import '../library/library.css';
import './search.css';

const LIBRARY_LIMIT = 30;

function itemTitle(item: LibraryWorkItem) {
  return item.kind === 'book' ? item.book.novel.title : item.work.title;
}

function SourceRow({ group }: { group: UiNextSearchSourceGroup }) {
  return (
    <section className="un-row un-search-row" aria-label={group.title}>
      <header className="un-row-head">
        <h2>
          {group.openAll ? (
            <button type="button" onClick={group.openAll}>
              {group.title}
              <ChevronRight size={20} />
            </button>
          ) : (
            group.title
          )}
        </h2>
        {group.openAll && (
          <button type="button" className="un-row-more" onClick={group.openAll}>
            전체 보기
          </button>
        )}
      </header>
      <RowRail count={group.items.length} startKey={group.items[0]?.id}>
        {group.items.map((work) => (
          <DiscoveryCard key={work.id} work={work} />
        ))}
      </RowRail>
    </section>
  );
}

/** Library and source results together. The library answers while typing; sources answer to 검색 only. */
export function UiNextSearchScreen({ adapter, initialQuery, close }: UiNextSearchScreenProps) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [menu, setMenu] = useState<LibraryWorkItem | null>(null);
  const trimmed = query.trim();
  const { libraryHelpers: library } = adapter;

  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  useEffect(() => {
    if (initialQuery?.trim()) adapterRef.current.submit(initialQuery);
    else input.current?.focus();
    return () => adapterRef.current.cancel();
  }, [initialQuery]);

  const leave = () => {
    adapter.cancel();
    close();
  };
  const search = (value: string) => {
    if (!value.trim()) return;
    setQuery(value);
    adapter.submit(value);
    // Drop the keyboard so the results have the screen.
    input.current?.blur();
  };

  const hits = trimmed ? adapter.library(trimmed) : [];
  const asked = trimmed !== '' && adapter.submitted === trimmed;
  const groups = asked ? adapter.sources : [];
  const found = groups.filter((group) => group.status === 'ready' && group.items.length > 0);
  const waiting = groups.filter((group) => group.status === 'loading' || group.status === 'idle');
  const empty = groups.filter((group) => group.status === 'ready' && group.items.length === 0);
  const failed = groups.filter((group) => group.status === 'failed');

  return (
    <div className="ui-next un-search" role="dialog" aria-modal="true" aria-label="검색">
      <form
        className="un-search-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search(query);
        }}
      >
        <button type="button" className="un-icon-btn" aria-label="검색 닫기" onClick={leave}>
          <ChevronLeft size={24} />
        </button>
        <label className="un-search-field">
          <Search size={19} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="제목, 작가, 태그"
            aria-label="검색어"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !query) leave();
            }}
          />
          {query && (
            <button
              type="button"
              className="un-search-clear"
              aria-label="검색어 지우기"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </label>
      </form>

      <div className="un-search-body">
        {!trimmed ? (
          adapter.recent.length > 0 ? (
            <section className="un-search-recent" aria-label="최근 검색">
              <header>
                <h2>최근 검색</h2>
                <button type="button" className="un-btn is-text is-sm" onClick={adapter.clearRecent}>
                  모두 지우기
                </button>
              </header>
              <ul>
                {adapter.recent.map((recent) => (
                  <li key={recent}>
                    <button type="button" className="un-search-recent-term" onClick={() => search(recent)}>
                      <History size={17} aria-hidden="true" />
                      <span>{recent}</span>
                    </button>
                    <button
                      type="button"
                      className="un-icon-btn is-sm"
                      aria-label={`${recent} 지우기`}
                      onClick={() => adapter.removeRecent(recent)}
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <div className="un-search-intro">
              <Search size={30} aria-hidden="true" />
              <b>무엇을 찾을까요?</b>
              <p>
                내 서재는 입력하는 대로 바로 찾고,
                {adapter.sources.length > 0 && <br />}
                {adapter.sources.length > 0 && '소스는 검색을 누르면 찾아요.'}
              </p>
            </div>
          )
        ) : (
          <>
            <section className="un-row un-search-row" aria-label="내 서재">
              <header className="un-row-head">
                <h2>
                  내 서재
                  {hits.length > 0 && <small className="un-search-count">{hits.length}</small>}
                </h2>
              </header>
              {hits.length > 0 ? (
                <RowRail count={hits.length} startKey={hits[0]?.key}>
                  {hits.slice(0, LIBRARY_LIMIT).map((item) => (
                    <WorkTile
                      key={item.key}
                      item={item}
                      layout="grid"
                      progress={
                        item.kind === 'book' ? library.bookProgress(item.book) : library.externalProgress(item.work)
                      }
                      task={
                        item.kind === 'book'
                          ? library.taskForBook(item.book.novel.id)
                          : library.taskForExternal(item.work.id)
                      }
                      selecting={false}
                      selected={false}
                      activate={() => void library.activate(item)}
                      openMenu={() => setMenu(item)}
                    />
                  ))}
                </RowRail>
              ) : (
                <p className="un-search-none">내 서재에는 없어요.</p>
              )}
            </section>

            {adapter.sources.length > 0 &&
              (!asked ? (
                <button type="button" className="un-search-go" onClick={() => search(query)}>
                  <span className="un-search-go-icon" aria-hidden="true">
                    <Search size={20} />
                  </span>
                  <span>
                    <b>‘{trimmed}’ 소스에서 찾기</b>
                    <small>소스 {adapter.sources.length}곳에서 새 작품을 찾아요</small>
                  </span>
                </button>
              ) : (
                <>
                  {waiting.length > 0 && (
                    <div className="un-search-progress" role="status">
                      <span>
                        소스 {groups.length}곳 중 {waiting.length}곳 찾는 중
                      </span>
                      <i aria-hidden="true" />
                    </div>
                  )}
                  {found.map((group) => (
                    <SourceRow key={group.sourceId} group={group} />
                  ))}
                  {!waiting.length && !found.length && (
                    <p className="un-search-none is-sources">소스에서도 찾지 못했어요. 다른 검색어로 해 보세요.</p>
                  )}
                  {(empty.length > 0 || failed.length > 0) && (
                    <ul className="un-search-misses" aria-label="결과가 없는 소스">
                      {failed.map((group) => (
                        <li key={group.sourceId} className="is-failed">
                          <span>
                            <b>{group.title}</b> · 불러오지 못했어요
                          </span>
                          <button type="button" className="un-btn is-text is-sm" onClick={group.retry}>
                            다시 시도
                          </button>
                        </li>
                      ))}
                      {empty.length > 0 && found.length > 0 && (
                        <li>
                          <span>결과 없음 · {empty.map((group) => group.title).join(', ')}</span>
                        </li>
                      )}
                    </ul>
                  )}
                </>
              ))}
          </>
        )}
      </div>

      <Sheet open={Boolean(menu)} onClose={() => setMenu(null)} title={menu ? itemTitle(menu) : undefined}>
        {menu && (
          <ActionList
            onDone={() => setMenu(null)}
            actions={(menu.kind === 'book'
              ? library.bookMenu(menu.book)
              : library.externalMenu(menu.work)
            ).flatMap<ActionEntry>((action, index, all) =>
              action.danger && index > 0 && !all[index - 1].danger ? ['divider', action] : [action],
            )}
          />
        )}
      </Sheet>
    </div>
  );
}
