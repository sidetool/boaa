import {
  AlertTriangle,
  BookCheck,
  BookOpen,
  BookX,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePenLine,
  FilePlus2,
  FileText,
  Folder,
  ListChecks,
  BellPlus,
  ListPlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslatedTitle } from '../../features/translation/use-translated-title';
import { useNearOnce } from '../home/rows';
import { externalItemKeyId } from '../../external-sources/contracts';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
} from '../../features/external-sources/external-source-controller-contract';
import type { SourceHubScreenProps } from '../../features/external-sources/source-hub-contract';
import {
  canSelectItem,
  importStateLabel,
  itemDescription,
  itemStateLabel,
  releaseReadingStateLabel,
  updatedLabel,
} from '../../features/external-sources/source-hub-item-model';
import {
  releaseDownloadAction,
  sourceHubItemActions,
  type SourceHubAction,
} from '../../features/external-sources/source-hub-item-actions';
import { SourceDownloadRecovery } from '../../features/external-sources/SourceDownloadRecovery';
import { SourceFilterControl } from '../../features/external-sources/SourceFilterControl';
import { SourceStreamReader } from '../../features/external-sources/SourceStreamReader';
import { isTextSourceItem } from '../../features/external-sources/source-read-mode';
import { Pager } from '../chapters/Pager';
import { Synopsis } from '../chapters/Synopsis';
import { DetailTags } from '../chapters/DetailTags';
import { SourceWorkTools as SourceWorkManagement } from './SourceWorkTools';
import { useSourceHubModel } from '../../features/external-sources/useSourceHubModel';
import { sourceEpisodeNumber } from '../../features/external-sources/source-primary-read';
import { useSourceReleaseList } from '../../features/external-sources/useSourceReleaseList';
import { SOURCE_RELEASE_PAGE_SIZE } from '../../features/external-sources/source-release-list-model';
import {
  importTaskIsActive,
  importTaskStageLabel,
  type ImportTaskView,
} from '../../features/import/import-task-projection';
import { formatBytes, formatCount } from '../../utils/format';
import { ActionList, cx, Progress, Segmented, Sheet, type ActionEntry } from '../components/primitives';
import { RemoteCover, WorkCover } from '../library/WorkTile';
import '../chapters/chapters.css';
import '../library/library.css';
import './source.css';

type Model = ReturnType<typeof useSourceHubModel>;

function DownloadButton({
  item,
  controller,
  task,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  task?: ImportTaskView;
}) {
  const action = releaseDownloadAction(item, controller, task);
  if (action.icon === 'unsupported')
    return (
      <button type="button" className="un-icon-btn" disabled aria-label="지원하지 않음">
        <X size={18} />
      </button>
    );
  return (
    <button
      type="button"
      className={cx('un-icon-btn', action.icon === 'progress' && 'is-progress')}
      disabled={action.disabled}
      aria-label={action.label}
      title={action.title}
      onClick={() => void action.run()}
    >
      {action.icon === 'progress' && task ? (
        <span className="un-ring" style={{ '--un-ring': `${task.percent ?? 0}%` } as React.CSSProperties}>
          <X size={12} />
        </span>
      ) : action.icon === 'retry' ? (
        <RotateCcw size={18} />
      ) : action.icon === 'delete' ? (
        <Trash2 size={18} />
      ) : action.icon === 'update' ? (
        <RefreshCw size={18} />
      ) : action.icon === 'read' ? (
        <Play size={18} />
      ) : (
        <Download size={18} />
      )}
    </button>
  );
}

function ReleaseSheet({
  item,
  controller,
  onClose,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  onClose(): void;
}) {
  const actions = sourceHubItemActions(item, controller);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [error, setError] = useState('');
  const entries: ActionEntry[] = [
    ...actions.menu.map((action) => ({
      ...action,
      run: () => void Promise.resolve(action.run()).catch(() => undefined),
    })),
  ];
  return (
    <Sheet open onClose={onClose} title={editing ? '회차 제목 수정' : item.title}>
      {editing ? (
        <form
          className="un-detail-rename"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            Promise.resolve(actions.rename(title))
              .then(onClose)
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '저장하지 못했어요.'));
          }}
        >
          <input
            aria-label="회차 제목"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <div>
            <button type="button" className="un-btn is-text" onClick={() => setEditing(false)}>
              취소
            </button>
            <button type="submit" className="un-btn is-primary" disabled={!title.trim()}>
              저장
            </button>
          </div>
          {error && (
            <p className="un-inline-alert" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <>
          <ActionList actions={entries} onDone={onClose} />
          {controller.renameRelease && (
            <div className="un-action-list">
              <button type="button" className="un-action" onClick={() => setEditing(true)}>
                <Pencil size={20} />
                <span>제목 수정</span>
              </button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function ReleaseRow({
  item,
  controller,
  task,
  openMenu,
  selecting,
  index,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  task?: ImportTaskView;
  openMenu(): void;
  selecting: boolean;
  index: number;
}) {
  const actions = sourceHubItemActions(item, controller);
  const selectable = canSelectItem(item);
  const reading = releaseReadingStateLabel(item);
  const state = task ? importTaskStageLabel(task) : (reading ?? importStateLabel(item.importState));
  const active = Boolean(task && importTaskIsActive(task));
  const current = item.readingState === 'current';
  const opening = controller.openingItemKey === externalItemKeyId(item.key);
  // In select mode a tap on the row toggles it, as in any list with a selection mode.
  const open = selecting
    ? selectable
      ? () => actions.toggleSelection()
      : undefined
    : actions.canRead
      ? () => void actions.read?.run()
      : actions.showStreamRead || controller.canStreamItem?.(item)
        ? () => void actions.streamRead()
        : undefined;
  return (
    <li
      className={cx(
        'un-chapter un-release',
        current && 'is-current',
        item.readingState === 'read' && 'is-read',
        item.selected && 'is-selected',
        opening && 'is-opening',
      )}
      aria-current={current ? 'location' : undefined}
    >
      {!selecting ? null : selectable ? (
        <label className="un-release-check">
          <input
            type="checkbox"
            checked={item.selected}
            disabled={controller.busy}
            aria-label={`${item.title} 선택`}
            onChange={actions.toggleSelection}
          />
          <span aria-hidden="true">{item.selected && <Check size={14} strokeWidth={3} />}</span>
        </label>
      ) : (
        <span className="un-release-check" aria-hidden="true" />
      )}
      <button
        type="button"
        className="un-chapter-open"
        disabled={!open || controller.blockingBusy}
        aria-label={`${item.title}, ${state}`}
        onClick={open}
      >
        <span className="un-chapter-index">{item.release ? sourceEpisodeNumber(item, index) : '—'}</span>
        <span className="un-chapter-text">
          <b>{item.title}</b>
          <small>
            {[item.subtitle, item.collection?.sourceLabel, updatedLabel(item.updatedAt)].filter(Boolean).join(' · ')}
          </small>
          {active && task && <Progress value={(task.percent ?? 0) / 100} className="un-chapter-progress" />}
        </span>
        <span className={cx('un-release-state', `is-${task?.phase ?? item.readingState ?? item.importState}`)}>
          {opening ? (
            <LoaderCircle size={13} className="un-spin" />
          ) : (
            current && !active && <Play size={12} fill="currentColor" />
          )}
          {opening ? '여는 중' : state}
        </span>
      </button>
      {actions.showReleaseDownload && <DownloadButton item={item} controller={controller} task={task} />}
      {(controller.renameRelease || actions.menu.length > 0) && (
        <button
          type="button"
          className="un-icon-btn"
          aria-label={`${item.title} 더보기`}
          disabled={controller.busy}
          onClick={openMenu}
        >
          <MoreHorizontal size={18} />
        </button>
      )}
    </li>
  );
}

function ReleaseList({ model }: { model: Model }) {
  const { controller, contentItems, taskByItemKey } = model;
  const list = useSourceReleaseList(controller, contentItems);
  const [menu, setMenu] = useState<ExternalSourceItemView | null>(null);
  const [selectRequested, setSelectRequested] = useState(false);
  // A selection that survives navigation keeps the list in select mode.
  const selecting = selectRequested || model.selectedCount > 0;
  const finishSelecting = () => {
    controller.selectAllSupported(false);
    setSelectRequested(false);
  };
  const filtered = Boolean(list.query) || list.readFilter !== 'all';
  // The first page of a freshly opened work: rows take the list's shape instead of a status line.
  const firstLoad = controller.loading && !contentItems.length && !controller.listError;
  return (
    <section className={cx('un-detail-chapters', selecting && 'is-selecting')} aria-label="회차">
      <div className="un-detail-toolbar">
        <label className="un-inline-search">
          <Search size={18} />
          <input
            type="search"
            value={list.query}
            placeholder="회차 번호나 제목"
            aria-label="회차 검색"
            onChange={(event) => list.changeQuery(event.target.value)}
          />
        </label>
        <Segmented
          label="읽음 상태 필터"
          value={list.readFilter}
          onChange={list.changeFilter}
          options={[
            { value: 'all', label: '전체' },
            { value: 'unread', label: '안 읽음' },
            { value: 'read', label: '읽음' },
          ]}
        />
        <button
          type="button"
          className="un-btn is-text is-sm"
          onClick={() => list.changeSort(list.sort === 'asc' ? 'desc' : 'asc')}
        >
          {list.sort === 'asc' ? '처음 화부터' : '최신 화부터'}
        </button>
        {selecting ? (
          <span className="un-release-select-tools">
            <label className="un-release-page-select">
              <input
                ref={list.selectionRef}
                type="checkbox"
                checked={list.selectable.length > 0 && list.selectedHere === list.selectable.length}
                disabled={!list.selectable.length || controller.busy}
                onChange={(event) => list.selectPage(event.target.checked)}
              />
              이 페이지 전체
            </label>
            <button type="button" className="un-btn is-ghost is-sm" onClick={finishSelecting}>
              완료
            </button>
          </span>
        ) : (
          list.selectable.length > 0 && (
            <button
              type="button"
              className="un-btn is-text is-sm un-release-select-start"
              disabled={controller.busy}
              onClick={() => setSelectRequested(true)}
            >
              <ListChecks size={16} aria-hidden="true" />
              선택
            </button>
          )
        )}
      </div>

      {(controller.catalogLoading || controller.deletingDownloads || controller.loading) && !firstLoad && (
        <p className="un-source-status" role="status">
          <LoaderCircle size={15} className="un-spin" />
          {controller.deletingDownloads
            ? '다운로드를 지우는 중'
            : controller.loading
              ? '전체 목차를 준비하고 있어요'
              : '목차를 확인하는 중'}
        </p>
      )}
      {list.partial && (
        <p className="un-source-status" role="status">
          {controller.loading || controller.catalogLoading
            ? '나머지 목차를 불러오는 중이에요. 그동안 회차를 고르거나 읽을 수 있어요.'
            : '목차 일부만 불러왔어요.'}{' '}
          검색과 정렬은 불러온 {formatCount(contentItems.length)}화에만 적용돼요.
          {list.cursor && !controller.loading && !controller.catalogLoading && !controller.listError && (
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={controller.blockingBusy || controller.importBusy}
              onClick={list.loadMore}
            >
              목차 더 불러오기
            </button>
          )}
        </p>
      )}
      {controller.listError && (
        <div className="un-source-error" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <b>목록을 불러오지 못했어요</b>
            <p>{controller.listError.message}</p>
          </div>
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            disabled={controller.loading || controller.blockingBusy}
            onClick={list.retryList}
          >
            <RefreshCw size={15} />
            다시 불러오기
          </button>
        </div>
      )}

      {list.sorted.length ? (
        <ul className="un-chapter-list" aria-label="작품 회차 목록">
          {list.page.items.map((item) => (
            <ReleaseRow
              index={list.sorted.indexOf(item)}
              key={externalItemKeyId(item.key)}
              item={item}
              controller={controller}
              task={taskByItemKey.get(externalItemKeyId(item.key))}
              openMenu={() => setMenu(item)}
              selecting={selecting}
            />
          ))}
        </ul>
      ) : firstLoad ? (
        <ul className="un-chapter-list un-release-skeleton" role="status" aria-label="회차를 불러오고 있어요">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="un-chapter" aria-hidden="true">
              <span className="un-release-skeleton-row">
                <i />
                <span>
                  <i />
                  <i />
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : !controller.loading ? (
        <div className="un-empty is-quiet">
          <b>{filtered ? '맞는 회차가 없어요' : '표시할 회차가 없어요'}</b>
          {filtered && (
            <button type="button" className="un-btn is-ghost" onClick={list.reset}>
              검색과 필터 지우기
            </button>
          )}
        </div>
      ) : null}

      {list.sorted.length > 0 && (
        <footer className="un-detail-pager">
          <small>
            {list.page.rangeStart}–{list.page.rangeEnd} / {formatCount(list.sorted.length)}화 · 페이지당{' '}
            {SOURCE_RELEASE_PAGE_SIZE}화
          </small>
          <Pager page={list.page.page} count={list.page.pageCount} onPage={list.setRequestedPage} />
        </footer>
      )}

      {menu && (
        <ReleaseSheet
          key={externalItemKeyId(menu.key)}
          item={menu}
          controller={controller}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

/** Browsable works render as posters; files and loose releases render as rows with their actions. */
function SourceItem({ item, model }: { item: ExternalSourceItemView; model: Model }) {
  const { controller, activeSource } = model;
  const libraryAddEnabled = Boolean(activeSource?.supportsSubscriptions);
  const actions = sourceHubItemActions(item, controller, undefined, libraryAddEnabled);
  const browsable = item.kind === 'work' && Boolean(item.navigationRef);
  const titleRef = useRef<HTMLDivElement>(null);
  const near = useNearOnce(titleRef);
  const title = useTranslatedTitle(item.title, browsable && near);

  if (browsable)
    return (
      <div ref={titleRef} className="un-tile un-source-work">
        <button
          type="button"
          className="un-tile-open"
          disabled={controller.blockingBusy || controller.loading}
          aria-label={`${title} 작품 상세 열기`}
          onClick={() => void actions.open()}
        >
          <span className="un-tile-art">
            {model.workLayout !== 'text' && (
              <RemoteCover title={item.title} author={item.author} url={item.thumbnailUrl} />
            )}
            {actions.added && <span className="un-tile-flag is-owned">추가됨</span>}
          </span>
          <span className="un-tile-meta">
            <span className="un-tile-title" title={title !== item.title ? item.title : undefined}>
              {title}
            </span>
            {itemDescription(item) && <span className="un-tile-sub">{itemDescription(item)}</span>}
          </span>
        </button>
        {libraryAddEnabled && !actions.added && (
          <button
            type="button"
            className="un-source-add"
            disabled={controller.busy || controller.loading}
            aria-label={`${item.title} 라이브러리 추가`}
            onClick={() => void actions.addWork?.run()}
          >
            <Plus size={18} />
          </button>
        )}
        {controller.canRemoveItems && (
          <button
            type="button"
            className="un-tile-more"
            disabled={controller.busy}
            aria-label={`${item.title} 선택 목록에서 제거`}
            onClick={() => void actions.remove()}
          >
            <X size={16} />
          </button>
        )}
      </div>
    );

  const selectable = canSelectItem(item);
  const primary: SourceHubAction | undefined = actions.canRead
    ? actions.read
    : item.importState === 'imported' || !selectable
      ? undefined
      : actions.import;
  return (
    <div className={cx('un-source-file', item.selected && 'is-selected')}>
      {selectable ? (
        <label className="un-release-check">
          <input
            type="checkbox"
            checked={item.selected}
            disabled={controller.busy}
            aria-label={`${item.title} 선택`}
            onChange={actions.toggleSelection}
          />
          <span aria-hidden="true">{item.selected && <Check size={14} strokeWidth={3} />}</span>
        </label>
      ) : (
        <span className="un-release-check" aria-hidden="true" />
      )}
      <span className="un-source-file-icon" aria-hidden="true">
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <FileText size={20} />}
      </span>
      <span className="un-source-file-text">
        <b title={item.title}>{item.title}</b>
        <small>
          {[
            itemDescription(item),
            item.formatHint,
            item.byteLength !== undefined ? formatBytes(item.byteLength) : undefined,
            updatedLabel(item.updatedAt),
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
        {item.localBookTitle && <small>서재: {item.localBookTitle}</small>}
      </span>
      <span className={cx('un-release-state', `is-${item.importState}`)}>
        {item.importState === 'imported' && <Check size={12} />}
        {selectable || item.importState === 'imported' ? itemStateLabel(item) : '지원하지 않음'}
      </span>
      {primary && (
        <button
          type="button"
          className={cx('un-btn is-sm', actions.canRead ? 'is-ghost' : 'is-primary')}
          disabled={primary.disabled}
          onClick={() => void primary.run()}
        >
          {actions.canRead ? (
            <BookOpen size={15} />
          ) : item.importState === 'update_available' ? (
            <RefreshCw size={15} />
          ) : (
            <Download size={15} />
          )}
          {actions.canRead ? '열기' : item.importState === 'update_available' ? '업데이트' : '가져오기'}
        </button>
      )}
      {controller.canRemoveItems && (
        <button
          type="button"
          className="un-icon-btn is-sm"
          disabled={controller.busy}
          aria-label={`${item.title} 선택 목록에서 제거`}
          onClick={() => void actions.remove()}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function WorkHero({ model, props }: { model: Model; props: SourceHubScreenProps }) {
  const { controller, seriesNovel, seriesLibraryBook, commands } = model;
  const [moreOpen, setMoreOpen] = useState(false);
  const editor = props.localSeriesTitleEditor;
  const description = controller.detail?.description ?? seriesNovel?.description;
  const title = useTranslatedTitle(model.workTitle, Boolean(controller.detail));
  const cover = seriesLibraryBook ? (
    <WorkCover item={{ kind: 'book', key: seriesLibraryBook.novel.id, book: seriesLibraryBook }} />
  ) : (
    <RemoteCover title={model.workTitle} author={controller.detail?.author} url={controller.detail?.thumbnailUrl} />
  );
  const primaryRead = model.primaryRead;
  const arriving = !seriesNovel && controller.loading && !model.contentItems.length && !controller.listError;
  const canRead = Boolean(primaryRead || seriesNovel || controller.canResumeCurrentWork);
  // Novels are read, comics and webtoons are watched; the verb follows the work, not the source.
  const verb =
    (primaryRead && isTextSourceItem(primaryRead.item)) ||
    seriesNovel?.format === 'txt' ||
    seriesNovel?.format === 'epub'
      ? '읽기'
      : '보기';
  const readLabel = primaryRead
    ? primaryRead.kind === 'continue'
      ? `${primaryRead.episodeNumber}화 이어 ${verb}`
      : `${primaryRead.episodeNumber}화 ${verb}`
    : controller.canResumeCurrentWork
      ? `이어 ${verb}`
      : seriesNovel?.totalChapters === 0
        ? '다운로드한 회차 없음'
        : model.seriesCanContinue
          ? `이어 ${verb}`
          : `첫 회차 ${verb}`;
  const more: ActionEntry[] = seriesNovel
    ? [
        ...(props.openLocalSeriesImport
          ? [
              {
                id: 'append',
                label: '로컬 회차 추가',
                icon: <Plus size={20} />,
                disabled: controller.busy || controller.loading,
                run: commands.importLocalReleases,
              },
            ]
          : []),
        ...(editor
          ? [
              {
                id: 'title',
                label: editor.editing ? '제목 수정 취소' : '제목 빠르게 고치기',
                icon: <Pencil size={20} />,
                disabled: controller.busy || controller.loading,
                run: editor.editing ? editor.cancel : editor.start,
              },
            ]
          : []),
      ]
    : [];

  return (
    <section className="un-detail-hero" aria-labelledby="un-source-title">
      <div className="un-detail-backdrop" aria-hidden="true">
        {cover}
      </div>
      <button
        type="button"
        className="un-detail-back"
        disabled={controller.blockingBusy && !seriesNovel}
        onClick={commands.back}
      >
        <ChevronLeft size={22} />
        <span>뒤로</span>
      </button>
      <div className="un-detail-body">
        <div className="un-detail-cover">{cover}</div>
        <div className="un-detail-copy">
          <div className="un-detail-info">
            {seriesNovel && editor?.editing ? (
              <form
                className="un-detail-title-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void editor.save();
                }}
              >
                <input
                  value={editor.draft}
                  onChange={(event) => editor.setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      editor.cancel();
                    }
                  }}
                  autoFocus
                  maxLength={120}
                  aria-label="책 제목"
                />
                <button type="submit" className="un-icon-btn" aria-label="책 제목 저장">
                  <Check size={20} />
                </button>
                <button type="button" className="un-icon-btn" aria-label="책 제목 수정 취소" onClick={editor.cancel}>
                  <X size={20} />
                </button>
              </form>
            ) : (
              <h1 id="un-source-title">{title}</h1>
            )}
            {title !== model.workTitle && <p className="un-detail-byline">{model.workTitle}</p>}
            {model.workByline && <p className="un-detail-byline">{model.workByline}</p>}
            <p className="un-detail-kicker">
              <span className="un-tag is-accent">{model.seriesReadingStatus ?? model.workSourceLabel}</span>
              {arriving ? (
                <span className="un-detail-kicker-wait" aria-hidden="true" />
              ) : (
                <>
                  <span>
                    {seriesNovel ? model.localArchiveFormat : (controller.detail?.status ?? '연재 정보 없음')}
                  </span>
                  <span>{formatCount(model.contentItems.length)}화</span>
                </>
              )}
              {/* The accent tag already names the source when there is no reading status to show. */}
              {model.seriesReadingStatus && <span>{model.workSourceLabel}</span>}
            </p>
            {model.workTags && model.workTags.length > 0 && <DetailTags tags={model.workTags} />}
          </div>
          <div className="un-detail-actions">
            {/* Holds the read button's place so the actions do not jump when the episodes arrive. */}
            {arriving && !canRead && <span className="un-detail-action-wait" aria-hidden="true" />}
            {canRead && (
              <button
                type="button"
                className="un-btn is-primary is-lg"
                disabled={
                  primaryRead
                    ? primaryRead.busy
                    : controller.blockingBusy ||
                      controller.loading ||
                      (!controller.canResumeCurrentWork && seriesNovel?.totalChapters === 0)
                }
                aria-busy={Boolean(primaryRead && controller.openingItemKey)}
                onClick={primaryRead ? () => void primaryRead.run() : commands.continueReading}
              >
                {primaryRead && controller.openingItemKey ? (
                  <LoaderCircle size={18} className="un-spin" />
                ) : (
                  <Play size={18} fill="currentColor" />
                )}
                <span className="un-detail-read-label">
                  {readLabel}
                  {primaryRead?.kind === 'continue' &&
                    primaryRead.episodeTitle !== `${primaryRead.episodeNumber}화` && (
                      <small>{primaryRead.episodeTitle}</small>
                    )}
                </span>
              </button>
            )}
            {controller.canSubscribeCurrentWork && !controller.activeSubscription && (
              <button
                type="button"
                className={cx('un-btn is-lg', canRead || arriving ? 'is-ghost' : 'is-primary')}
                disabled={controller.busy || controller.loading}
                onClick={commands.addCurrentWorkToLibrary}
              >
                {seriesNovel ? <BellPlus size={18} /> : <Plus size={18} />}
                {/* Already on the shelf: following only adds new episodes as they come out. */}
                {seriesNovel ? '새 회차 받기' : '서재에 추가'}
              </button>
            )}
            {seriesNovel && (
              <button
                type="button"
                className={cx('un-detail-icon-action', seriesNovel.favorite && 'is-on')}
                disabled={controller.busy || controller.loading}
                aria-pressed={seriesNovel.favorite}
                onClick={commands.toggleFavorite}
              >
                <Star size={22} fill={seriesNovel.favorite ? 'currentColor' : 'none'} />
                <span>즐겨찾기</span>
              </button>
            )}
            {seriesNovel && (
              <button
                type="button"
                className="un-detail-icon-action"
                disabled={controller.busy || controller.loading}
                aria-label="작품 정보 편집"
                onClick={commands.editMetadata}
              >
                <FilePenLine size={22} />
                <span>편집</span>
              </button>
            )}
            {more.length > 0 && (
              <button
                type="button"
                className="un-detail-icon-action"
                aria-label="더보기"
                onClick={() => setMoreOpen(true)}
              >
                <MoreHorizontal size={22} />
                <span>더보기</span>
              </button>
            )}
          </div>
          {description && <Synopsis text={description} />}
        </div>
      </div>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={model.workTitle}>
        <ActionList actions={more} onDone={() => setMoreOpen(false)} />
      </Sheet>
    </section>
  );
}

function SourceHead({ model }: { model: Model }) {
  const { controller, activeSource, commands } = model;
  const nested = controller.breadcrumbs.length > 1;
  return (
    <header className="un-source-head">
      <button
        type="button"
        className="un-icon-btn"
        aria-label={nested ? '상위 폴더' : '닫기'}
        disabled={controller.blockingBusy}
        onClick={nested ? commands.goBack : commands.close}
      >
        <ChevronLeft size={24} />
      </button>
      <div className="un-source-head-title">
        <small>{activeSource?.kind === 'cloud_file' ? '파일 소스' : '작품 소스'}</small>
        <h1>{activeSource?.title ?? '외부 소스'}</h1>
      </div>
      <div className="un-source-head-actions">
        {controller.canPickItems && (
          <button
            type="button"
            className="un-btn is-primary is-sm"
            disabled={controller.busy || controller.loading}
            onClick={commands.pickItems}
          >
            {controller.busy ? <LoaderCircle size={15} className="un-spin" /> : <FilePlus2 size={15} />}
            <span>파일 추가</span>
          </button>
        )}
        {model.connected && (
          <button
            type="button"
            className="un-icon-btn"
            aria-label="새로고침"
            disabled={controller.loading || controller.blockingBusy}
            onClick={commands.refresh}
          >
            <RefreshCw size={20} className={controller.loading ? 'un-spin' : undefined} />
          </button>
        )}
        <button
          type="button"
          className="un-icon-btn"
          aria-label="소스 관리"
          disabled={controller.busy}
          onClick={commands.openSourceSettings}
        >
          <Settings size={20} />
        </button>
      </div>
    </header>
  );
}

export default function UiNextSourceHubScreen(props: SourceHubScreenProps) {
  const model = useSourceHubModel(props);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { controller, activeSource, commands, contentItems, folders } = model;

  if (model.streamReaderProps) return <SourceStreamReader {...model.streamReaderProps} />;
  if (!model.seriesNovel && (!activeSource || !model.connected)) return null;

  const catalog = activeSource?.kind === 'catalog';
  const browse = controller.browse;
  const selectedItems = contentItems.filter((item) => item.selected);
  const showBatch =
    (controller.selectedBatchActive && controller.importBusy) || (model.selectedCount > 0 && !controller.importBusy);

  return (
    <div
      ref={model.scrollRef}
      className={cx('un-source', model.hasWorkHero && 'is-work')}
      aria-busy={controller.loading}
    >
      {!model.hasWorkHero && <SourceHead model={model} />}
      <SourceDownloadRecovery controller={controller} />
      {model.hasWorkHero && <WorkHero model={model} props={props} />}
      {model.hasWorkHero && (
        <div className="un-source-manage">
          <SourceWorkManagement novel={model.seriesNovel} controller={controller} library={props.library} />
        </div>
      )}

      {activeSource?.supportsSubscriptions && !controller.detail && model.sourceSubscriptions.length > 0 && (
        <section className="un-row un-source-subscriptions" aria-label="서재에 추가한 작품">
          <header className="un-row-head">
            <h2>
              서재에 추가한 작품 <small>{formatCount(model.sourceSubscriptions.length)}</small>
            </h2>
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={controller.busy || controller.loading || controller.checkingSubscriptions}
              onClick={commands.checkSubscriptions}
            >
              <RefreshCw size={14} className={controller.checkingSubscriptions ? 'un-spin' : undefined} />새 회차 확인
            </button>
          </header>
          <div className="un-row-track un-source-sub-track">
            {model.sourceSubscriptions.map((subscription) => (
              <button
                key={subscription.id}
                type="button"
                className="un-source-sub"
                disabled={controller.blockingBusy || controller.loading}
                onClick={() => void commands.openSubscription(subscription)}
              >
                <b>{subscription.title}</b>
                <small>
                  {subscription.author ?? '작가 정보 없음'} · {formatCount(subscription.availableReleaseCount)}화
                </small>
                <small>마지막 확인 {updatedLabel(subscription.lastCheckedAt) ?? '기록 없음'}</small>
                {subscription.newReleaseIds.length > 0 && (
                  <span className="un-tag is-accent">새 회차 {subscription.newReleaseIds.length}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {!model.hasWorkHero &&
        (controller.breadcrumbs.length > 1 || controller.stale || controller.currentLocationCanBeDefault) && (
          <div className="un-source-crumbs">
            <nav aria-label="현재 외부 소스 위치">
              {controller.breadcrumbs.map((crumb, index) => (
                <span key={`${crumb.parentRef ?? 'root'}:${index}`}>
                  {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
                  {crumb.label}
                </span>
              ))}
            </nav>
            {controller.stale && <span className="un-tag">저장된 목록</span>}
            {controller.currentLocationCanBeDefault && (
              <button
                type="button"
                className="un-btn is-text is-sm"
                disabled={controller.busy || controller.loading}
                aria-label={controller.currentFolderIsDefault ? '기본 폴더 해제' : '현재 폴더를 기본 폴더로 설정'}
                onClick={commands.toggleDefaultFolder}
              >
                {controller.currentFolderIsDefault ? <PinOff size={14} /> : <Pin size={14} />}
                {controller.currentFolderIsDefault ? '기본 폴더 해제' : '기본 폴더로'}
              </button>
            )}
          </div>
        )}

      {browse && !controller.detail && (
        <div className="un-chip-row un-source-modes" role="group" aria-label="소스 탐색 방식">
          <button
            type="button"
            className={cx('un-chip', browse.activeMode === 'popular' && 'is-active')}
            disabled={controller.blockingBusy || controller.loading}
            onClick={() => void commands.setBrowseMode('popular')}
          >
            인기
          </button>
          {browse.availableModes.includes('latest') && (
            <button
              type="button"
              className={cx('un-chip', browse.activeMode === 'latest' && 'is-active')}
              disabled={controller.blockingBusy || controller.loading}
              onClick={() => void commands.setBrowseMode('latest')}
            >
              최신
            </button>
          )}
          {browse.activeMode === 'search' && (
            <span className="un-chip is-active">{controller.query.trim() ? '검색 결과' : '필터 결과'}</span>
          )}
          {Boolean(browse.filters?.length) && (
            <button type="button" className="un-chip" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={15} />
              필터
            </button>
          )}
          {props.library?.actions.header.saveDiscoveryList && (
            <button
              type="button"
              className="un-chip"
              disabled={controller.loading || controller.blockingBusy}
              onClick={commands.saveDiscoveryList}
            >
              <ListPlus size={15} />
              탐색에 추가
            </button>
          )}
        </div>
      )}

      {model.updateCount > 0 && (
        <div className="un-source-error is-warning" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <b>
              {formatCount(model.updateCount)}개 {model.releaseList ? '회차' : '작품'}에 원격 업데이트가 있어요
            </b>
            <p>직접 업데이트하기 전까지 서재의 본문은 그대로예요.</p>
          </div>
        </div>
      )}

      {folders.length > 0 && (
        <section className="un-source-folders" aria-label="폴더">
          {folders.map((folder) => (
            <button
              key={externalItemKeyId(folder.key)}
              type="button"
              disabled={controller.loading || controller.blockingBusy}
              onClick={() => void commands.openFolder(folder)}
            >
              <Folder size={20} />
              <span>{folder.title}</span>
              <ChevronRight size={18} />
            </button>
          ))}
        </section>
      )}

      {model.hasWorkHero && (
        <div className="un-detail-tabs">
          <div className="un-underline-tabs" role="tablist" aria-label="작품 상세">
            <button type="button" role="tab" aria-selected className="is-active">
              회차
              {(contentItems.length > 0 || !controller.loading) && <small>{formatCount(contentItems.length)}</small>}
            </button>
          </div>
        </div>
      )}

      {model.releaseList ? (
        <ReleaseList key={model.releaseLocationKey} model={model} />
      ) : (
        <section className="un-source-items" aria-label={controller.detail ? '회차' : catalog ? '작품' : '파일'}>
          <div className="un-source-toolbar">
            <form className="un-discover-search un-source-search" role="search" onSubmit={model.submitSearch}>
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                value={controller.query}
                disabled={controller.blockingBusy}
                placeholder={catalog ? '작품 제목 검색' : '파일 검색'}
                aria-label={catalog ? '작품 검색' : '외부 소스 검색'}
                onChange={(event) => commands.setQuery(event.target.value)}
              />
            </form>
            {catalog && !controller.detail && (
              <Segmented
                label="소스 보기 방식"
                value={model.workLayout === 'compact' ? 'compact' : 'grid'}
                onChange={(value) => model.changeWorkLayout(value)}
                options={[
                  { value: 'grid', label: '크게' },
                  { value: 'compact', label: '작게' },
                ]}
              />
            )}
            {model.selectableItems.length > 0 && (
              <label className="un-release-page-select">
                <input
                  type="checkbox"
                  checked={model.allSelected}
                  disabled={controller.busy}
                  onChange={(event) => commands.selectAllSupported(event.target.checked)}
                />
                모두 선택
              </label>
            )}
          </div>

          {controller.listError && (
            <div className="un-source-error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <b>목록을 불러오지 못했어요</b>
                <p>{controller.listError.message}</p>
              </div>
              <button
                type="button"
                className="un-btn is-ghost is-sm"
                disabled={controller.loading || controller.blockingBusy}
                onClick={commands.retryList}
              >
                <RefreshCw size={15} />
                다시 불러오기
              </button>
            </div>
          )}

          {controller.loading && controller.items.length === 0 ? (
            <div className="un-grid is-grid" role="status" aria-label="목록을 불러오고 있어요">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className="un-skeleton" aria-hidden="true">
                  <span />
                  <i />
                  <i />
                </span>
              ))}
            </div>
          ) : controller.items.length === 0 && !controller.listError ? (
            <div className="un-empty is-quiet">
              <b>
                {controller.nextCursor && controller.query.trim()
                  ? '이 페이지에는 검색 결과가 없어요'
                  : '표시할 파일이나 작품이 없어요'}
              </b>
              <p>
                {controller.nextCursor && controller.query.trim()
                  ? '더 보기로 나머지 결과를 확인해 보세요.'
                  : controller.canPickItems
                    ? '파일 추가로 연결할 파일을 골라 보세요.'
                    : '다른 폴더를 열거나 검색어를 바꿔 보세요.'}
              </p>
            </div>
          ) : contentItems.length > 0 ? (
            <div
              className={cx(
                'un-source-list',
                contentItems.some((item) => item.kind === 'work' && item.navigationRef)
                  ? `un-grid is-${model.workLayout === 'compact' ? 'compact' : 'grid'}`
                  : 'is-rows',
              )}
              aria-label="외부 소스 작품 목록"
            >
              {contentItems.map((item) => (
                <SourceItem key={externalItemKeyId(item.key)} item={item} model={model} />
              ))}
            </div>
          ) : null}

          {controller.loading && controller.items.length > 0 && (
            <p className="un-source-status" role="status" aria-live="polite">
              <LoaderCircle size={15} className="un-spin" />
              목록을 불러오는 중
            </p>
          )}
          {controller.nextCursor && (
            <div className="un-discover-more">
              <button
                type="button"
                className="un-btn is-ghost"
                disabled={controller.loading || controller.blockingBusy}
                onClick={commands.loadMore}
              >
                {controller.loading && <LoaderCircle size={15} className="un-spin" />}더 보기
              </button>
            </div>
          )}
        </section>
      )}

      {showBatch && (
        <div className="un-select-bar un-source-batch" role={controller.importBusy ? 'status' : undefined}>
          {controller.selectedBatchActive && controller.importBusy ? (
            <>
              <span className="un-source-batch-label">
                <LoaderCircle size={17} className="un-spin" />
                <b>선택 회차 다운로드 중</b>
                {controller.progress && (
                  <small>
                    {contentItems.some((item) => item.collection?.seriesProfile?.kind === 'document_series') &&
                      `수신 ${formatCount(controller.progress.current)} · 저장 `}
                    {formatCount(controller.progress.completed)}/{formatCount(controller.progress.total)}
                  </small>
                )}
              </span>
              <button type="button" onClick={commands.cancel}>
                <X size={20} />
                <span>중단</span>
              </button>
            </>
          ) : (
            <>
              <span className="un-source-batch-label">
                <b>{formatCount(model.selectedCount)}개 선택</b>
              </span>
              {model.selectedDownloadCount > 0 && (
                <button type="button" disabled={controller.busy} onClick={commands.importSelected}>
                  {model.selectedUpdateCount === model.selectedDownloadCount ? (
                    <RefreshCw size={20} />
                  ) : (
                    <Download size={20} />
                  )}
                  <span>
                    {model.selectedUpdateCount === 0
                      ? model.releaseList
                        ? '다운로드'
                        : '가져오기'
                      : model.selectedUpdateCount === model.selectedDownloadCount
                        ? '업데이트'
                        : '가져오기·업데이트'}
                  </span>
                </button>
              )}
              {controller.setReleasesRead && (
                <>
                  <button
                    type="button"
                    disabled={controller.busy}
                    onClick={() => void controller.setReleasesRead?.(selectedItems, true).catch(() => undefined)}
                  >
                    <BookCheck size={20} />
                    <span>읽음</span>
                  </button>
                  <button
                    type="button"
                    disabled={controller.busy}
                    onClick={() => void controller.setReleasesRead?.(selectedItems, false).catch(() => undefined)}
                  >
                    <BookX size={20} />
                    <span>안 읽음</span>
                  </button>
                </>
              )}
              {model.selectedDownloaded.length > 0 && (
                <button
                  type="button"
                  className="is-danger"
                  disabled={controller.busy}
                  onClick={commands.deleteSelectedDownloads}
                >
                  <Trash2 size={20} />
                  <span>다운로드 삭제 {model.selectedDownloaded.length}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}

      {browse?.filters && (
        <Sheet
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          title="필터"
          footer={
            <>
              <button
                type="button"
                className="un-btn is-text"
                disabled={controller.blockingBusy || controller.loading}
                onClick={commands.resetFilters}
              >
                <RotateCcw size={15} />
                초기화
              </button>
              <button
                type="button"
                className="un-btn is-primary"
                disabled={controller.blockingBusy || controller.loading}
                onClick={() => {
                  commands.applyFilters();
                  setFiltersOpen(false);
                }}
              >
                적용
              </button>
            </>
          }
        >
          <div className="un-filter-fields">
            {browse.filters.map((definition) => (
              <SourceFilterControl
                key={definition.id}
                definition={definition}
                value={controller.filterValues[definition.id]}
                setValue={(value) => commands.setFilterValue(definition.id, value)}
              />
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
