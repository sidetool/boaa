/** Item action data shared by classic and ui-next. Actions do not swallow errors or guard run():
 * callers preserve their existing error handling and honor disabled. releaseDownloadAction preserves
 * precedence: active task → retry → delete saved → unsupported → update/queue/read.
 * sourceHubItemActions returns download, read, import, addWork, open, remove, toggleSelection,
 * menu actions and rename(title). Menu title editing UI remains the caller's responsibility.
 */
import type { ExternalSourceController, ExternalSourceItemView } from './external-source-controller-contract';
import { externalItemKeyId } from '../../external-sources/contracts';
import { importTaskIsActive, type ImportTaskView } from '../import/import-task-projection';
import { canSelectItem } from './source-hub-item-model';
export interface SourceHubAction {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  run(): void | Promise<void>;
}
export function canReadSourceItem(item: ExternalSourceItemView) {
  return Boolean(item.localBookId && (item.importState === 'imported' || item.importState === 'update_available'));
}
export function releaseDownloadAction(
  item: ExternalSourceItemView,
  controller: ExternalSourceController,
  task?: ImportTaskView,
): SourceHubAction & {
  title: string;
  icon: 'progress' | 'retry' | 'delete' | 'unsupported' | 'update' | 'read' | 'download';
} {
  if (task && importTaskIsActive(task)) {
    const title = task.phase === 'cancelling' ? '취소 중' : '다운로드 중단';
    return {
      id: 'cancel',
      icon: 'progress',
      title,
      label: `${item.title} ${title}`,
      disabled: task.phase === 'cancelling',
      run: controller.cancel,
    };
  }
  if (task?.phase === 'failed' && !canReadSourceItem(item))
    return {
      id: 'retry',
      icon: 'retry',
      title: '다시 시도',
      label: `${item.title} 다시 시도`,
      disabled: controller.busy || controller.loading,
      run: () => controller.importItem(item),
    };
  if (canReadSourceItem(item))
    return {
      id: 'delete-download',
      icon: 'delete',
      title: '다운로드 삭제',
      label: `${item.title} 다운로드 삭제`,
      disabled: controller.busy,
      danger: true,
      run: () => controller.deleteDownloads([item]),
    };
  if (!canSelectItem(item))
    return {
      id: 'unsupported',
      icon: 'unsupported',
      title: '지원하지 않음',
      label: '지원하지 않음',
      disabled: true,
      run: () => undefined,
    };
  const streaming = controller.canStreamItem?.(item) === true;
  const updating = item.importState === 'update_available';
  const queueing = controller.canQueueItem(item);
  const blocked = controller.importBusy && !queueing && !streaming;
  const actionLabel = updating
    ? '업데이트'
    : queueing && !streaming
      ? '다운로드 대기열에 추가'
      : streaming
        ? '바로 읽기'
        : '다운로드 후 보기';
  return {
    id: updating ? 'update' : queueing && !streaming ? 'queue' : 'read',
    icon: updating ? 'update' : streaming ? 'read' : 'download',
    title: blocked ? '다른 작품 다운로드 중' : actionLabel,
    label: `${item.title} ${actionLabel}`,
    disabled: controller.blockingBusy || controller.loading || blocked,
    run: () => (updating || (queueing && !streaming) ? controller.importItem(item) : controller.importAndOpen(item)),
  };
}
export function sourceHubItemActions(
  item: ExternalSourceItemView,
  controller: ExternalSourceController,
  task?: ImportTaskView,
  libraryAddEnabled = false,
) {
  const canRead = canReadSourceItem(item);
  const added = libraryAddEnabled && controller.isWorkInLibrary(item);
  const read: SourceHubAction | undefined = canRead
    ? {
        id: 'open-saved',
        label: '라이브러리에서 보기',
        disabled: controller.blockingBusy,
        run: () => controller.openImported(item),
      }
    : undefined;
  const importAction: SourceHubAction = {
    id: 'import',
    label: item.importState === 'update_available' ? '업데이트' : '라이브러리로 추가',
    disabled: controller.busy || controller.loading,
    run: () => controller.importItem(item),
  };
  const addWork: SourceHubAction | undefined = libraryAddEnabled
    ? {
        id: 'add-work',
        label: added ? '라이브러리 추가됨' : '라이브러리 추가',
        disabled: controller.busy || controller.loading || added,
        run: () => controller.addWorkToLibrary(item),
      }
    : undefined;
  const menu: SourceHubAction[] = [
    {
      id: 'toggle-read',
      label: item.readingState === 'read' ? '안 읽음으로 변경' : '읽음으로 변경',
      run: () => controller.setReleasesRead?.([item], item.readingState !== 'read'),
    },
    { id: 'read-previous', label: '이전 회차 모두 읽음', run: () => controller.markPreviousReleasesRead?.(item) },
    ...(canRead
      ? [{ id: 'delete-download', label: '다운로드 삭제', danger: true, run: () => controller.deleteDownloads([item]) }]
      : []),
  ];
  return {
    canRead,
    added,
    read,
    import: importAction,
    addWork,
    menu,
    download: () => releaseDownloadAction(item, controller, task),
    showStreamRead:
      !canRead &&
      Boolean(task && (importTaskIsActive(task) || task.phase === 'failed') && controller.canStreamItem?.(item)),
    showReleaseDownload:
      item.importState !== 'imported' || Boolean(task && importTaskIsActive(task)) || !controller.renameRelease,
    streamRead: () => controller.importAndOpen(item),
    open: () => controller.openItem(item),
    remove: () => controller.removeItem(item),
    toggleSelection: () => controller.toggleItem(externalItemKeyId(item.key)),
    rename: (title: string) => controller.renameRelease?.(item, title),
  };
}
