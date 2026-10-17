import type { LibraryScreenProps, LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryBookView } from '../../features/library/library-screen-model';
import { importTaskIsActive } from '../../features/import/import-task-projection';
import type { LibraryAction, LibraryBatchInput } from './contract';

export function libraryAction(
  id: string,
  label: string,
  run: LibraryAction['run'],
  disabled = false,
  danger = false,
): LibraryAction {
  return { id, label, disabled, danger, run: () => (disabled ? undefined : run()) };
}
export function bookMenuActions({ model, actions }: LibraryScreenProps, book: LibraryBookView): LibraryAction[] {
  const { novel } = book;
  const a = actions.books;
  const disabled =
    model.management.busy ||
    model.importTasks.some((task) => task.targetBookId === novel.id && importTaskIsActive(task));
  if (novel.deletedAt)
    return [
      libraryAction('restore', '복원', () => a.restore(novel), disabled),
      libraryAction('purge', '영구 삭제', () => a.purge(novel), disabled, true),
    ];
  return [
    libraryAction('continue', book.directActionLabel, () => a.continueReading(novel)),
    libraryAction('open', '작품 정보', () => a.open(novel)),
    libraryAction('favorite', novel.favorite ? '즐겨찾기 해제' : '즐겨찾기', () => a.toggleFavorite(novel), disabled),
    ...(a.moveToShelf ? [libraryAction('move', '책장 이동', () => a.moveToShelf!(novel), disabled)] : []),
    ...(a.rename ? [libraryAction('rename', '제목 수정', () => a.rename!(novel), disabled)] : []),
    ...(model.management.available
      ? [libraryAction('metadata', '정보 편집', () => a.editMetadata(novel), disabled)]
      : []),
    libraryAction(
      'download',
      '원본 받기',
      () => (a.downloadFromMenu ?? a.downloadSource)(novel),
      disabled || !(a.canDownloadFromMenu ? a.canDownloadFromMenu(novel) : novel.sourceAssetId),
    ),
    libraryAction('remove', '휴지통으로 이동', () => a.remove(novel), disabled, true),
  ];
}
export function externalMenuActions(
  { model, actions }: LibraryScreenProps,
  work: LibraryExternalWorkView,
): LibraryAction[] {
  const a = actions.books;
  const disabled =
    model.management.busy ||
    model.importTasks.some((task) => task.externalWorkId === work.id && importTaskIsActive(task));
  if (work.deletedAt)
    return [
      ...(a.restoreExternal ? [libraryAction('restore', '복원', () => a.restoreExternal!(work.id), disabled)] : []),
      ...(a.purgeExternal
        ? [libraryAction('purge', '영구 삭제', () => a.purgeExternal!(work.id), disabled, true)]
        : []),
    ];
  return [
    ...(a.continueExternal
      ? [libraryAction('continue', work.lastReadAt ? '이어 보기' : '첫 화 보기', () => a.continueExternal!(work.id))]
      : []),
    libraryAction('open', '작품 정보', () => a.openExternal(work.id)),
    ...(a.renameExternal ? [libraryAction('rename', '제목 수정', () => a.renameExternal!(work.id), disabled)] : []),
    ...(a.moveExternalToShelf
      ? [libraryAction('move', '책장 이동', () => a.moveExternalToShelf!(work.id), disabled)]
      : []),
    ...(a.downloadExternal
      ? [libraryAction('download', '다운로드', () => a.downloadExternal!(work.id), disabled)]
      : []),
    libraryAction('remove', '휴지통으로 이동', () => a.removeExternal(work.id), disabled, true),
  ];
}

/** Covers every LibraryBatchBar command; input fields and layout belong to the UI. */
export function batchLibraryActions(
  { model, actions }: LibraryScreenProps,
  input: LibraryBatchInput = {},
): LibraryAction[] {
  const { management } = model;
  const disabled = !management.selectionMode || !management.selectedBookIds.size || management.busy;
  const streaming = [...management.selectedBookIds].some((id) => id.startsWith('external:'));
  const shelfId = input.shelfId ?? management.activeShelfId ?? management.shelves[0]?.id ?? '';
  const validShelf = management.shelves.some((shelf) => shelf.id === shelfId);
  const tag = input.tag ?? '';
  const apply = actions.controls.applyBatch;
  return [
    libraryAction(
      'add_to_shelf',
      '선택 책장에 추가',
      () => apply({ kind: 'add_to_shelf', shelfId }),
      disabled || !validShelf,
    ),
    libraryAction(
      'remove_from_shelf',
      '선택 책장에서 제외',
      () => apply({ kind: 'remove_from_shelf', shelfId }),
      disabled || !validShelf,
    ),
    libraryAction('add_tag', '태그 추가', () => apply({ kind: 'add_tag', tag }), disabled || streaming || !tag.trim()),
    libraryAction(
      'remove_tag',
      '태그 제거',
      () => apply({ kind: 'remove_tag', tag }),
      disabled || streaming || !tag.trim(),
    ),
    libraryAction(
      'favorite',
      '즐겨찾기 설정',
      () => apply({ kind: 'set_favorite', favorite: true }),
      disabled || streaming,
    ),
    libraryAction(
      'unfavorite',
      '즐겨찾기 해제',
      () => apply({ kind: 'set_favorite', favorite: false }),
      disabled || streaming,
    ),
    libraryAction('export', '정보 내보내기', actions.controls.exportSelectedMetadata, disabled || streaming),
    model.filter === 'trash'
      ? libraryAction('restore', '복원', () => apply({ kind: 'restore_from_trash' }), disabled)
      : libraryAction('remove', '휴지통으로 이동', () => apply({ kind: 'move_to_trash' }), disabled, true),
  ];
}
