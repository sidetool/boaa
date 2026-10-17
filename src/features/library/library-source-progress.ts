import { formatCount } from '../../utils/format';
import type { SourceWorkProgress } from '../external-sources/source-work-progress';
import type { LibraryExternalWorkView } from './library-screen-contract';
import { isFixedDocumentFormat } from '../../domain/book-format';
import {
  buildLibraryViewCatalog,
  selectLibraryCollection,
  type BuildLibraryCollectionInput,
  type LibraryBookView,
  type LibraryCollectionModel,
} from './library-screen-model';

/** Shows a source work's progress against the source's full release list instead of its downloads. */
export function withSourceProgress(book: LibraryBookView, progress: SourceWorkProgress | undefined): LibraryBookView {
  if (!progress) return book;
  // Unknown source totals carry activity only; keep the known local progress presentation.
  if (progress.totalCount <= 0) return { ...book, activityAt: progress.lastReadAt };
  const isFinished = progress.sourcePosition ? progress.progress >= 1 : book.isFinished;
  const isUnread = progress.sourcePosition
    ? book.isUnread && !progress.lastReadAt && progress.readCount === 0
    : book.isUnread;
  const canContinue = !isUnread;
  return {
    ...book,
    activityAt: progress.lastReadAt,
    isFinished,
    isUnread,
    canContinue,
    readingStatusLabel: isFinished ? '완독' : isUnread ? '미독' : '읽는 중',
    directActionLabel: isFixedDocumentFormat(book.novel.format)
      ? canContinue
        ? '이어 보기'
        : '문서 열기'
      : canContinue
        ? '이어 읽기'
        : '첫 화 보기',
    sourcePosition: progress.sourcePosition,
    bookProgress: progress.progress,
    readingCounts: { current: progress.readCount, total: progress.totalCount, unit: '화' },
    readingPositionLabel: `${formatCount(progress.readCount)} / ${formatCount(progress.totalCount)}화`,
  };
}

/** Re-select from the full effective catalog, including books excluded by the previous status filter. */
export function applySourceProgress(
  collection: LibraryCollectionModel,
  byNovelId: ReadonlyMap<string, SourceWorkProgress> | undefined,
  selection: Pick<BuildLibraryCollectionInput, 'query' | 'filter' | 'sort'> = {
    query: '',
    filter: 'all',
    sort: 'recent',
  },
): LibraryCollectionModel {
  if (!byNovelId || byNovelId.size === 0) return collection;
  const books = [...collection.booksByNovelId.values()].map((book) =>
    withSourceProgress(book, byNovelId.get(book.novel.id)),
  );
  return selectLibraryCollection(buildLibraryViewCatalog(books), selection);
}

/** Remote works show releases read out of the source total once any have been read. */
export function externalWorkReleaseLabel(work: LibraryExternalWorkView): string {
  const total = formatCount(work.availableReleaseCount);
  return work.readReleaseCount ? `${formatCount(work.readReleaseCount)}/${total}화` : `${total}화`;
}

export function externalWorkListMeta(work: LibraryExternalWorkView): string {
  return [
    work.author,
    work.sourceLabel,
    `원격 회차 ${formatCount(work.availableReleaseCount)}개`,
    work.readReleaseCount ? `${formatCount(work.readReleaseCount)}화 읽음` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
