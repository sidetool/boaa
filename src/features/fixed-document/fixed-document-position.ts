import type { Chapter, ReadingPosition } from '../../domain/types';
import type { ComicViewportPosition } from './use-comic-viewport-position';

/** Fixed documents have no text caret: encode their anchor as integer millionths in the
 * existing synced offset field. Zero remains the legacy page-top position. Completion
 * (chapterProgress) stays independent of the viewport anchor. */
export function fixedDocumentOffset(fraction = 0): number {
  return Number.isFinite(fraction) ? Math.round(Math.max(0, Math.min(0.999999, fraction)) * 1_000_000) : 0;
}
export function fixedDocumentFraction(offset = 0): number {
  return Math.max(0, Math.min(999_999, offset)) / 1_000_000;
}
export function fixedDocumentPosition(
  chapters: readonly Chapter[],
  position?: ReadingPosition,
  initialChapterId?: string,
): ComicViewportPosition | undefined {
  if (!position || (initialChapterId && initialChapterId !== position.chapterId)) return;
  const page = chapters.findIndex((chapter) => chapter.id === position.chapterId);
  if (page < 0) return;
  const fraction = fixedDocumentFraction(position.offsetInParagraph);
  return { page, fraction: Number.isFinite(fraction) && fraction >= 0 && fraction < 1 ? fraction : 0, ratio: 1.5 };
}
