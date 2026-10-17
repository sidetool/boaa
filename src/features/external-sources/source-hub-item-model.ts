/** Pure classic-compatible selectors: importStateLabel/itemStateLabel/releaseReadingStateLabel,
 * canSelectItem, updatedLabel (Korean date), sourceFileExtension and itemDescription.
 * No controller effects or UI dependencies; use alongside sourceHubItemActions for row/card rendering.
 */
import type { ExternalSourceItemImportState, ExternalSourceItemView } from './external-source-controller-contract';

export function importStateLabel(state: ExternalSourceItemImportState): string {
  switch (state) {
    case 'imported':
      return '가져옴';
    case 'update_available':
      return '업데이트 있음';
    case 'unsupported':
      return '지원하지 않음';
    default:
      return '추가 가능';
  }
}

export function itemStateLabel(item: ExternalSourceItemView): string {
  if (item.kind === 'work' && item.navigationRef) return '탐색 가능';
  return importStateLabel(item.importState);
}

export function releaseReadingStateLabel(item: ExternalSourceItemView): string | undefined {
  if (item.readingState === 'current') return '읽는 중';
  if (item.readingState === 'read') return '읽음';
  if (item.readingState === 'unread') return '안 읽음';
  return undefined;
}

export function canSelectItem(item: ExternalSourceItemView): boolean {
  return (
    item.kind !== 'folder' &&
    item.importability !== 'unsupported' &&
    (item.importState === 'available' ||
      item.importState === 'update_available' ||
      (item.importState === 'imported' && Boolean(item.release)))
  );
}

export function updatedLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(timestamp);
}

export function sourceFileExtension(fileName: string | undefined): string {
  const leafName = fileName?.split(/[\\/]/u).at(-1)?.trim();
  const extension = leafName?.match(/\.([^.]+)$/u)?.[1]?.trim();
  return extension ? extension.toLocaleUpperCase() : '파일';
}

export function itemDescription(item: ExternalSourceItemView): string | undefined {
  return (
    [...new Set([item.author, item.subtitle].filter((value): value is string => Boolean(value)))].join(' · ') ||
    undefined
  );
}
