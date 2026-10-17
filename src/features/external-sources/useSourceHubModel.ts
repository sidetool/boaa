/** useSourceHubModel(props: SourceHubScreenProps) — headless source/detail screen model.
 * primaryRead / primaryReadFor(sort): data-only first/continue episode descriptor; no presentation labels.
 * Hero: activeSource/connected, hasWorkHero, seriesNovel, workTitle/workByline/workTags/workSourceLabel,
 * seriesLibraryBook/seriesReadingStatus/seriesCanContinue, readingActionLabel and localArchiveFormat.
 * Toolbar: workLayout/changeWorkLayout, submitSearch(event); commands.search/refresh/setQuery,
 * setBrowseMode/setFilterValue/resetFilters/applyFilters/openSourceSettings/saveDiscoveryList.
 * Releases: releaseList/releaseLocationKey/contentItems; itemActions(item) returns named executable
 * item/menu actions. Mount useSourceReleaseList separately in the release panel to retain its lifecycle.
 * Folders: folders/sourceSubscriptions; commands.openFolder/openSubscription/goBack/toggleDefaultFolder,
 * checkSubscriptions/pickItems. commands.back uses app history with the existing detail fallback.
 * Selection: selectableItems/selectedCount/selectedDownloadCount/selectedDownloaded/selectedUpdateCount/
 * allSelected/updateCount; commands.toggleItem/selectAllSupported/importSelected/deleteSelectedDownloads.
 * Download/reader: taskByItemKey, streamNavigation, streamReaderProps (undefined unless streaming),
 * scrollRef (attach to scroll container; restores navigation and focuses requested download selection).
 * commands.cancel/close/addCurrentWorkToLibrary/continueReading/toggleFavorite/editMetadata/
 * importLocalReleases/retryList/loadMore and titleEditor expose existing operations unchanged.
 * controller is returned intact for raw loading/error/progress/capability/breadcrumb/detail state.
 */
import { sourceComicProfileKey } from './source-comic-profile-key';
import { sourcePrimaryRead } from './source-primary-read';
import type { ReleaseSort } from './source-release-list-model';

import { useMemo, useRef, type FormEvent, type ComponentProps } from 'react';
import { useDownloadSelectionFocus } from './use-download-selection-focus';
import { useSourceWorkReadingTime } from './source-work-reading-time';
import { useSourceStreamNavigation } from './use-source-stream-navigation';
import { sourceReadingPreferences } from '../../external-sources/source-reading-preferences';
import { useSourceWorkLayout } from './source-work-layout';
import { useNavigationScroll } from '../navigation/navigation-view-state';
import { navigateAppBack } from '../navigation/browser-navigation';
import { externalItemKeyId } from '../../external-sources/contracts';
import { isTextStream } from '../../external-sources/source-text-stream';
import { importTaskIsActive, type ImportTaskView } from '../import/import-task-projection';
import type { SourceStreamReader } from './SourceStreamReader';
import type { SourceHubScreenProps } from './source-hub-contract';
import { canSelectItem, sourceFileExtension } from './source-hub-item-model';
import { sourceHubItemActions } from './source-hub-item-actions';

export function useSourceHubModel({
  downloadRequest,
  textReader,
  controller,
  library,
  openSourceSettings,
  openLocalSeriesImport,
  localSeriesNovel,
  localSeriesTitleEditor,
}: SourceHubScreenProps) {
  useSourceWorkReadingTime(
    controller.workReadingSessionId,
    Boolean(controller.streaming && !controller.streamingBookId),
  );
  const streamNavigation = useSourceStreamNavigation(controller, sourceReadingPreferences().prefetch > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useDownloadSelectionFocus(
    scrollRef,
    downloadRequest,
    controller.activeSubscription?.id,
    controller.loading,
    controller.items.length,
  );
  const [workLayout, changeWorkLayout] = useSourceWorkLayout();
  const taskByItemKey = useMemo(() => {
    const tasks = new Map<string, ImportTaskView>();
    for (const task of controller.tasks) {
      if (task.externalItemKey && !tasks.has(task.externalItemKey)) tasks.set(task.externalItemKey, task);
    }
    return tasks;
  }, [controller.tasks]);
  const seriesNovel = localSeriesNovel ?? controller.localSeriesNovel;
  const readingActionLabel = controller.canResumeCurrentWork
    ? '이어 보기'
    : seriesNovel?.totalChapters === 0
      ? '다운로드한 회차 없음'
      : undefined;
  const activeSource = controller.sources.find((source) =>
    seriesNovel ? source.id === controller.localSeriesSourceId : source.id === controller.activeSourceId,
  );
  const folders = useMemo(() => controller.items.filter((item) => item.kind === 'folder'), [controller.items]);
  const contentItems = useMemo(() => controller.items.filter((item) => item.kind !== 'folder'), [controller.items]);
  const selectableItems = contentItems.filter(canSelectItem);
  const selectedCount = selectableItems.filter((item) => item.selected).length;
  const selectedDownloadCount = selectableItems.filter(
    (item) => item.selected && item.importState !== 'imported',
  ).length;
  const selectedDownloaded = contentItems.filter(
    (item) =>
      item.selected &&
      item.release &&
      item.localBookId &&
      (item.importState === 'imported' || item.importState === 'update_available'),
  );
  const updateCount = contentItems.filter((item) => item.importState === 'update_available').length;
  const selectedUpdateCount = selectableItems.filter(
    (item) => item.selected && item.importState === 'update_available',
  ).length;
  const allSelected = selectableItems.length > 0 && selectedCount === selectableItems.length;
  const releaseList = Boolean(controller.detail || seriesNovel);
  const releaseLocationKey = JSON.stringify([
    activeSource?.id,
    activeSource?.connection.accountConnectionId,
    seriesNovel?.id,
    controller.breadcrumbs.at(-1)?.parentRef,
    controller.detail?.title,
  ]);
  const hasWorkHero = Boolean(seriesNovel || controller.detail);
  const connected = activeSource?.connection.state === 'connected';
  const workTitle = seriesNovel?.title ?? controller.detail?.title ?? '연재 작품';
  const workByline = [
    controller.detail?.author ?? seriesNovel?.author,
    controller.detail?.artist,
    controller.detail?.status,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const workTags = controller.detail?.tags ?? seriesNovel?.tags;
  const workSourceLabel = controller.detail?.sourceLabel ?? activeSource?.title ?? '로컬 라이브러리';
  const seriesLibraryBook = seriesNovel ? library.model.collection.booksByNovelId?.get(seriesNovel.id) : undefined;
  const seriesReadingStatus =
    seriesLibraryBook?.readingStatusLabel ??
    (seriesNovel
      ? seriesNovel.lastReadAt || seriesNovel.lastReadProgress > 0
        ? seriesNovel.lastReadProgress >= 1
          ? '완독'
          : '읽는 중'
        : '미독'
      : undefined);
  const seriesCanContinue = seriesLibraryBook ? !seriesLibraryBook.isUnread : seriesReadingStatus !== '미독';
  const localArchiveFormat = seriesNovel
    ? seriesNovel.format === 'txt'
      ? 'TXT'
      : sourceFileExtension(seriesNovel.sourceFileName)
    : undefined;
  const sourceSubscriptions = activeSource
    ? controller.libraryWorks.filter(
        (subscription) =>
          !subscription.deletedAt &&
          subscription.connectorId === activeSource.id &&
          (subscription.accountConnectionId ?? '') === (activeSource.connection.accountConnectionId ?? ''),
      )
    : [];

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controller.blockingBusy) void controller.search();
  };

  useNavigationScroll(scrollRef, releaseLocationKey, !controller.loading && !controller.streaming);

  const commands = {
    continueReading: () => {
      if (controller.canResumeCurrentWork) void controller.resumeCurrentWork?.();
      else if (seriesNovel) void library.actions.books.continueReading(seriesNovel);
    },
    back: () => navigateAppBack(() => (seriesNovel ? controller.close() : controller.goBack())),
    goBack: () => navigateAppBack(controller.goBack),
    toggleDefaultFolder: () =>
      void (controller.currentFolderIsDefault
        ? controller.clearDefaultFolder()
        : controller.setCurrentFolderAsDefault()),
    toggleFavorite: () => {
      if (seriesNovel) void library.actions.books.toggleFavorite(seriesNovel);
    },
    editMetadata: () => {
      if (seriesNovel) library.actions.books.editMetadata(seriesNovel);
    },
    importLocalReleases: () => {
      if (seriesNovel) openLocalSeriesImport?.(seriesNovel);
    },
    deleteSelectedDownloads: () => void controller.deleteDownloads(selectedDownloaded),
    retryList: () => void controller.listError?.retry(),
    search: () => void controller.search(),
    refresh: () => void controller.refresh(),
    importSelected: () => void controller.importSelected(),
    pickItems: () => void controller.pickItems(),
    checkSubscriptions: () => void controller.checkSubscriptions(),
    addCurrentWorkToLibrary: () => void controller.addCurrentWorkToLibrary(),
    loadMore: () => void controller.loadMore(),
    resetFilters: () => void controller.resetFilters(),
    applyFilters: () => void controller.applyFilters(),
    close: controller.close,
    cancel: controller.cancel,
    setQuery: controller.setQuery,
    setBrowseMode: controller.setBrowseMode,
    setFilterValue: controller.setFilterValue,
    selectAllSupported: controller.selectAllSupported,
    toggleItem: controller.toggleItem,
    openFolder: controller.openFolder,
    openSubscription: controller.openSubscription,
    openSourceSettings,
    saveDiscoveryList: library.actions.header.saveDiscoveryList,
    titleEditor: localSeriesTitleEditor,
  };
  const itemActions = (item: Parameters<typeof sourceHubItemActions>[0]) =>
    sourceHubItemActions(
      item,
      controller,
      taskByItemKey.get(externalItemKeyId(item.key)),
      Boolean(activeSource?.supportsSubscriptions),
    );
  let streamReaderProps: ComponentProps<typeof SourceStreamReader> | undefined;
  if (controller.streaming) {
    const { item, port } = controller.streaming;
    const task = taskByItemKey.get(externalItemKeyId(item.key));
    const nextItem = streamNavigation.nextItem;
    streamReaderProps = {
      textReader,
      fromStart: controller.streaming.fromStart,
      historyKey: controller.streaming.historyKey ?? externalItemKeyId(item.key),
      title: item.release?.title ?? item.title,
      workTitle: seriesNovel?.title ?? controller.detail?.title ?? item.collection?.title,
      profileKey: isTextStream(port)
        ? JSON.stringify([item.key.connectorId, item.key.accountConnectionId, item.collection?.remoteId])
        : sourceComicProfileKey(item, controller.streaming.historyKey ?? externalItemKeyId(item.key)),
      nextEpisode:
        nextItem && controller.canStreamItem?.(nextItem)
          ? { remoteId: nextItem.key.remoteId, remoteRevision: nextItem.remoteRevision, title: nextItem.title }
          : undefined,
      remoteId: item.key.remoteId,
      remoteRevision: item.remoteRevision,
      port,
      onClose: () => controller.closeStream?.(),
      onSave: () => (controller.saveStream ?? controller.importItem)(item),
      onTextPosition: (position) => controller.saveTextStreamPosition?.(item, position) ?? Promise.resolve(),
      onPageSettled: (page, count, fraction) => controller.saveStreamPosition?.(item, page, count, fraction),
      saved:
        task?.phase === 'complete' ||
        controller.items.some(
          (candidate) =>
            externalItemKeyId(candidate.key) === externalItemKeyId(item.key) &&
            ['imported', 'update_available'].includes(candidate.importState),
        ),
      saveBusy: Boolean(task && importTaskIsActive(task)),
      previous: streamNavigation.previous,
      next: streamNavigation.next,
      navigationBusy: streamNavigation.busy,
    };
  }
  return {
    streamNavigation,
    scrollRef,
    workLayout,
    changeWorkLayout,
    taskByItemKey,
    seriesNovel,
    readingActionLabel,
    activeSource,
    folders,
    contentItems,
    selectableItems,
    selectedCount,
    selectedDownloadCount,
    selectedDownloaded,
    updateCount,
    selectedUpdateCount,
    allSelected,
    releaseList,
    releaseLocationKey,
    hasWorkHero,
    connected,
    workTitle,
    workByline,
    workTags,
    workSourceLabel,
    seriesLibraryBook,
    seriesReadingStatus,
    seriesCanContinue,
    localArchiveFormat,
    sourceSubscriptions,
    submitSearch,
    commands,
    itemActions,
    streamReaderProps,
    primaryRead: sourcePrimaryRead(controller),
    primaryReadFor: (sort: ReleaseSort) => sourcePrimaryRead(controller, sort),
    controller,
  };
}
