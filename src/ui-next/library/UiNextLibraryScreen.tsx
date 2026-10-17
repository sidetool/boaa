import {
  ArrowDownUp,
  ArrowLeft,
  CheckSquare,
  FileUp,
  FolderPlus,
  FolderOpen,
  Compass,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Search,
  Archive,
  Trash2,
  Pencil,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LibraryFilter } from '../../features/library/library-screen-model';
import { useNavigationScroll } from '../../features/navigation/navigation-view-state';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import type { ImportTaskView } from '../../features/import/import-task-projection';
import { ActionList, cx, Segmented, Sheet, type ActionEntry } from '../components/primitives';
import type { LibraryAction, UiNextLibraryScreenProps } from './contract';
import { SelectionBar } from './SelectionBar';
import { ImportTaskTile, WorkTile, type TileLayout } from './WorkTile';
import './library.css';

const STATUS_TABS: { filter: LibraryFilter; label: string }[] = [
  { filter: 'all', label: '전체' },
  { filter: 'reading', label: '읽는 중' },
  { filter: 'finished', label: '완독' },
  { filter: 'unread', label: '안 읽음' },
  { filter: 'trash', label: '휴지통' },
];

const IMPORT_ICONS: Record<string, ReactNode> = {
  file: <FileUp size={22} />,
  folder: <FolderPlus size={22} />,
  discovery: <Compass size={22} />,
};
const IMPORT_DETAIL: Record<string, string> = {
  file: 'TXT · EPUB · PDF · 만화 압축 파일',
  folder: '폴더에 새 파일이 생기면 서재에 더해요',
  discovery: '탐색에서 작품을 찾아 서재에 담아요',
};
const MANAGE_ICONS: Record<string, ReactNode> = {
  select: <CheckSquare size={18} />,
  shelves: <Pencil size={18} />,
  trash: <Trash2 size={18} />,
  empty_trash: <Trash2 size={18} />,
  sync: <RefreshCw size={18} />,
  backup: <Archive size={18} />,
};

type SheetState =
  { kind: 'import' } | { kind: 'manage' } | { kind: 'item'; title: string; actions: readonly LibraryAction[] } | null;

function itemTitle(item: LibraryWorkItem) {
  return item.kind === 'book' ? item.book.novel.title : item.work.title;
}

function SearchField({ query, setQuery, request }: { query: string; setQuery(value: string): void; request: number }) {
  const [open, setOpen] = useState(Boolean(query));
  const input = useRef<HTMLInputElement>(null);
  const firstRequest = useRef(request);
  useEffect(() => {
    if (request === firstRequest.current) return;
    setOpen(true);
    requestAnimationFrame(() => input.current?.focus());
  }, [request]);
  if (!open && !query)
    return (
      <button
        type="button"
        className="un-icon-btn"
        aria-label="서재 검색"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <Search size={21} />
      </button>
    );
  return (
    <label className="un-inline-search">
      <Search size={18} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="제목, 작가"
        aria-label="서재 검색어"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setQuery('');
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="un-icon-btn is-sm"
        aria-label="검색 닫기"
        onClick={() => {
          setQuery('');
          setOpen(false);
        }}
      >
        <X size={16} />
      </button>
    </label>
  );
}

function SkeletonGrid() {
  return (
    <div className="un-grid is-grid" aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="un-skeleton">
          <span />
          <i />
          <i />
        </div>
      ))}
    </div>
  );
}

export function UiNextLibraryScreen({ model, actions, notice, navigation, adapter }: UiNextLibraryScreenProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  useNavigationScroll(
    scrollRef,
    `ui-next-library:${model.management.activeShelfId ?? ''}:${model.query}:${model.filter}:${model.sort}`,
    model.bootstrap.status === 'ready',
  );

  const { management, collection } = model;
  const selecting = management.selectionMode;
  const inTrash = model.filter === 'trash';
  const layout: TileLayout = model.viewMode;
  const isList = layout === 'list' || layout === 'text';
  const counts = adapter.filterCounts;
  const total = collection.totalBooks;
  const activeShelf = management.shelves.find((shelf) => shelf.id === management.activeShelfId);
  const emptyLibrary =
    model.bootstrap.status === 'ready' &&
    total === 0 &&
    !model.query &&
    model.filter === 'all' &&
    !activeShelf &&
    adapter.standaloneImportTasks.length === 0;
  const close = () => setSheet(null);

  const openItemMenu = (item: LibraryWorkItem) =>
    setSheet({
      kind: 'item',
      title: itemTitle(item),
      actions: item.kind === 'book' ? adapter.bookMenu(item.book) : adapter.externalMenu(item.work),
    });
  const openTaskMenu = (task: ImportTaskView) =>
    setSheet({ kind: 'item', title: task.title, actions: adapter.importActions(task) });

  const manageEntries: ActionEntry[] = [
    ...adapter.sortActions,
    'divider',
    ...adapter.managementActions
      .filter((action) => action.id !== 'sync' && action.id !== 'backup')
      .map((action) => ({
        ...action,
        icon: MANAGE_ICONS[action.id],
        detail: action.id === 'trash' ? String(counts.trash) : undefined,
      })),
    'divider',
    ...adapter.managementActions
      .filter((action) => action.id === 'sync' || action.id === 'backup')
      .map((action) => ({ ...action, icon: MANAGE_ICONS[action.id] })),
  ];

  return (
    <main
      ref={scrollRef}
      className={cx('un-library', selecting && 'is-selecting')}
      aria-busy={model.bootstrap.status === 'loading'}
      onDragEnter={actions.drag.enter}
      onDragOver={actions.drag.over}
      onDragLeave={actions.drag.leave}
      onDrop={actions.drag.drop}
    >
      <header className="un-library-head">
        {selecting ? (
          <>
            <button
              type="button"
              className="un-icon-btn"
              aria-label="선택 끝내기"
              onClick={actions.controls.clearSelection}
            >
              <X size={22} />
            </button>
            <h1 className="un-library-title is-select">{management.selectedBookIds.size}개 선택</h1>
            <button type="button" className="un-btn is-text" onClick={actions.controls.selectVisible}>
              모두 선택
            </button>
          </>
        ) : inTrash ? (
          <>
            <button
              type="button"
              className="un-icon-btn"
              aria-label="서재로"
              onClick={() => actions.controls.setFilter('all')}
            >
              <ArrowLeft size={22} />
            </button>
            <h1 className="un-library-title is-select">
              휴지통 <small>{counts.trash}</small>
            </h1>
            {adapter.managementActions
              .filter((action) => action.id === 'empty_trash')
              .map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="un-btn is-text is-danger"
                  disabled={action.disabled}
                  onClick={() => void action.run()}
                >
                  비우기
                </button>
              ))}
          </>
        ) : (
          <>
            <h1 className="un-library-title">
              {activeShelf ? activeShelf.name : '서재'} <small>{total}</small>
            </h1>
            <div className="un-library-actions">
              <SearchField
                query={model.query}
                setQuery={actions.header.setQuery}
                request={navigation.searchFocusRequest}
              />
              <button
                type="button"
                className="un-icon-btn"
                aria-label={isList ? '표지로 보기' : '목록으로 보기'}
                onClick={() => actions.controls.setViewMode(isList ? 'grid' : 'list')}
              >
                {isList ? <LayoutGrid size={21} /> : <List size={21} />}
              </button>
              <button
                type="button"
                className="un-icon-btn"
                aria-label="정렬과 관리"
                onClick={() => setSheet({ kind: 'manage' })}
              >
                <ArrowDownUp size={20} />
              </button>
              <button
                type="button"
                className="un-btn is-primary is-sm un-add"
                aria-label="가져오기"
                onClick={() => setSheet({ kind: 'import' })}
              >
                <Plus size={18} />
                <span>가져오기</span>
              </button>
            </div>
          </>
        )}
      </header>

      {!inTrash && !selecting && (
        <div className="un-library-filters">
          <div className="un-underline-tabs" role="tablist" aria-label="읽기 상태">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.filter}
                type="button"
                role="tab"
                aria-selected={model.filter === tab.filter}
                className={cx(model.filter === tab.filter && 'is-active')}
                onClick={() => actions.controls.setFilter(tab.filter)}
              >
                {tab.label}
                <small>{counts[tab.filter]}</small>
              </button>
            ))}
          </div>
          <div className="un-chip-row" role="toolbar" aria-label="책장">
            <button
              type="button"
              className={cx('un-chip', !activeShelf && model.filter !== 'favorite' && 'is-active')}
              aria-pressed={!activeShelf && model.filter !== 'favorite'}
              onClick={() => {
                actions.controls.setShelf(undefined);
                if (model.filter === 'favorite') actions.controls.setFilter('all');
              }}
            >
              모든 책장
            </button>
            <button
              type="button"
              className={cx('un-chip', model.filter === 'favorite' && 'is-active')}
              aria-pressed={model.filter === 'favorite'}
              onClick={() => actions.controls.setFilter(model.filter === 'favorite' ? 'all' : 'favorite')}
            >
              즐겨찾기 <small>{counts.favorite}</small>
            </button>
            {management.shelves.map((shelf) => (
              <button
                key={shelf.id}
                type="button"
                className={cx('un-chip', activeShelf?.id === shelf.id && 'is-active')}
                aria-pressed={activeShelf?.id === shelf.id}
                onClick={() => actions.controls.setShelf(activeShelf?.id === shelf.id ? undefined : shelf.id)}
              >
                {shelf.name} <small>{model.presentation.shelfBookCounts.get(shelf.id) ?? 0}</small>
              </button>
            ))}
            {management.available && (
              <button
                type="button"
                className="un-chip is-icon"
                aria-label="책장 관리"
                onClick={actions.controls.openShelves}
              >
                <FolderPlus size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {notice && <div className="un-library-notice">{notice}</div>}

      {model.externalSources.libraryBootstrap?.status === 'failed' && actions.header.retrySourceLibrary && (
        <div className="un-inline-alert">
          <span>스트리밍 작품 목록을 불러오지 못했어요.</span>
          <button type="button" className="un-btn is-text" onClick={actions.header.retrySourceLibrary}>
            다시 시도
          </button>
        </div>
      )}

      {model.bootstrap.status === 'loading' ? (
        <SkeletonGrid />
      ) : model.bootstrap.status === 'failed' ? (
        <div className="un-empty">
          <b>서재를 불러오지 못했어요</b>
          {model.bootstrap.message && <p>{model.bootstrap.message}</p>}
          <button type="button" className="un-btn is-primary" onClick={actions.header.retryBootstrap}>
            다시 시도
          </button>
        </div>
      ) : emptyLibrary ? (
        <div className="un-empty" onDrop={actions.drag.dropOnEmptyState}>
          <span className="un-empty-icon" aria-hidden="true">
            <Upload size={28} />
          </span>
          <b>서재가 비어 있어요</b>
          <p>텍스트·EPUB·PDF·만화 파일을 가져오거나 이 화면에 끌어 놓으세요.</p>
          <button type="button" className="un-btn is-primary is-lg" onClick={actions.header.openImport}>
            <FileUp size={20} />
            파일 가져오기
          </button>
          <button type="button" className="un-btn is-text" onClick={() => void actions.books.addSample()}>
            샘플 작품 넣어 보기
          </button>
        </div>
      ) : adapter.works.length === 0 && adapter.standaloneImportTasks.length === 0 ? (
        <div className="un-empty is-quiet">
          <p>
            {model.query
              ? `‘${model.query}’에 맞는 작품이 없어요.`
              : inTrash
                ? '휴지통이 비어 있어요.'
                : '이 조건에 맞는 작품이 없어요.'}
          </p>
        </div>
      ) : (
        <div className={cx('un-grid', `is-${layout}`)}>
          {adapter.standaloneImportTasks.map((task) => (
            <ImportTaskTile key={`task:${task.id}`} task={task} layout={layout} openMenu={() => openTaskMenu(task)} />
          ))}
          {adapter.works.map((item) => (
            <WorkTile
              key={item.key}
              item={item}
              layout={layout}
              progress={item.kind === 'book' ? adapter.bookProgress(item.book) : adapter.externalProgress(item.work)}
              task={
                item.kind === 'book' ? adapter.taskForBook(item.book.novel.id) : adapter.taskForExternal(item.work.id)
              }
              selecting={selecting}
              selected={adapter.isSelected(item)}
              activate={() =>
                // Trashed works have no reader to open; a tap offers 복원 / 영구 삭제 instead of doing nothing.
                !selecting && (item.kind === 'book' ? item.book.novel.deletedAt : item.work.deletedAt)
                  ? openItemMenu(item)
                  : void adapter.activate(item)
              }
              openMenu={() => openItemMenu(item)}
              pick={adapter.pick ? () => adapter.pick!(item) : undefined}
            />
          ))}
        </div>
      )}

      {model.drop.active && (
        <div className="un-drop" aria-hidden="true">
          <div>
            <Upload size={28} />
            <b>{model.drop.importBusy ? '지금 가져오는 작업이 끝나면 더할게요' : '놓으면 서재에 더해요'}</b>
          </div>
        </div>
      )}

      {selecting && <SelectionBar batch={adapter.batchActions} shelves={management.shelves} inTrash={inTrash} />}

      <Sheet open={sheet?.kind === 'import'} onClose={close} title="서재에 추가">
        <div className="un-import-options">
          {adapter.importMenu.map((action) => (
            <button
              key={action.id}
              type="button"
              className="un-import-option"
              disabled={action.disabled}
              onClick={() => {
                close();
                void action.run();
              }}
            >
              <span className="un-import-icon">{IMPORT_ICONS[action.id] ?? <FolderOpen size={22} />}</span>
              <span>
                <b>{action.label}</b>
                {IMPORT_DETAIL[action.id] && <small>{IMPORT_DETAIL[action.id]}</small>}
              </span>
            </button>
          ))}
        </div>
        <p className="un-drop-hint">파일을 서재 화면에 끌어 놓아도 돼요.</p>
      </Sheet>

      <Sheet open={sheet?.kind === 'manage'} onClose={close} title="정렬과 관리">
        <div className="un-manage-view">
          <Segmented
            label="보기 방식"
            value={layout}
            onChange={actions.controls.setViewMode}
            options={[
              { value: 'grid', label: '표지' },
              { value: 'compact', label: '작은 표지' },
              { value: 'list', label: '목록' },
              { value: 'text', label: '제목만' },
            ]}
          />
        </div>
        <ActionList actions={manageEntries} onDone={close} />
      </Sheet>

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
    </main>
  );
}
