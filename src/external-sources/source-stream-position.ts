import { fixedDocumentFraction } from '../features/fixed-document/fixed-document-position';
import type { Chapter, Novel, ReadingPosition } from '../domain/types';
import type { SourceStreamPosition } from './source-stream-history';

/** Translate the persisted work-wide page/progress back to this episode's page coordinates. */
export function savedSourceStreamPosition(
  novel: Novel,
  chapters: readonly Chapter[],
  position?: ReadingPosition,
): SourceStreamPosition | undefined {
  const page = chapters.findIndex((chapter) => chapter.id === (position?.chapterId ?? novel.lastReadChapterId));
  const updatedAt = Date.parse(position?.updatedAt ?? novel.lastReadAt ?? '');
  if (page < 0 || !Number.isFinite(updatedAt)) return;
  const fraction = position ? fixedDocumentFraction(position.offsetInParagraph) : 0;
  return { page, count: chapters.length, fraction, ratio: 1.5, updatedAt };
}
export function latestSourceStreamPosition(
  count: number,
  ...positions: (SourceStreamPosition | undefined)[]
): SourceStreamPosition | undefined {
  return positions
    .filter((position): position is SourceStreamPosition => Boolean(position && position.count === count))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
