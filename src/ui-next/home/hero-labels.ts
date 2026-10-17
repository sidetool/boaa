import { isFixedDocumentFormat } from '../../domain/book-format';
import type { LibraryBookView } from '../../features/library/library-screen-model';

/** The same activity timestamp as hero ordering; missing timestamps stay blank. */
export function relativeLastReadLabel(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  const days = Math.floor(minutes / 1440);
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export interface HomeCurrentChapter {
  index: number;
  title?: string;
}
export function bookHeroLabels(book: LibraryBookView, reason: 'continue' | 'new', chapter?: HomeCurrentChapter) {
  if (reason === 'new' || isFixedDocumentFormat(book.novel.format)) {
    return { positionLabel: book.readingPositionLabel, resumeLabel: book.directActionLabel };
  }
  if (book.sourcePosition)
    chapter = { index: book.sourcePosition.episodeNumber, title: book.sourcePosition.episodeTitle };
  // readingCounts.current can count completed source releases, not the actual resumed chapter.
  const current = chapter?.index ?? book.novel.lastReadChapterIndex;
  if (!current || current < 1) return { positionLabel: book.readingPositionLabel, resumeLabel: book.directActionLabel };
  const title = chapter?.title?.trim();
  // Source episodes are often titled just "N화"; repeating it reads as "6화 · 6화".
  const redundant = !title || title.replace(/\s/g, '') === `${current}화` || title === String(current);
  const total = book.sourcePosition?.total ?? book.readingCounts?.total ?? book.novel.totalChapters;
  return {
    positionLabel: redundant ? `${current}화 / ${total}화` : `${current}화 · ${title}`,
    resumeLabel: `${current}화 이어 읽기`,
  };
}
