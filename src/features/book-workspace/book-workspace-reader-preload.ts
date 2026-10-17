import type { Chapter, Novel } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { loadSharedParagraphPage } from '../reader/shared-paragraph-pages';
import type { BookWorkspaceReaderOpenOptions } from './book-workspace-contract';

/** Start the opening body read alongside reader artifacts, sharing the viewport cache. */
export function preloadBookWorkspaceReaderBody(
  repository: ReaderBodyRepository,
  novel: Novel,
  chapter: Chapter,
  options: BookWorkspaceReaderOpenOptions,
): void | Promise<void> {
  if (options.targetParagraphId || chapter.paragraphCount <= 0) return;
  let index = 0;
  if (options.restore) {
    const position = options.position;
    if (position) {
      if (position.chapterId !== chapter.id || position.paragraphIndex <= 0) return;
      index = Math.min(position.paragraphIndex - 1, chapter.paragraphCount - 1);
    } else if (novel.lastReadChapterId === chapter.id && novel.lastReadOffset > 0) {
      return;
    }
  }
  const revision =
    novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}:${chapter.textHash}:${chapter.paragraphCount}`;
  return loadSharedParagraphPage(repository, revision, chapter.id, Math.floor(index / PARAGRAPHS_PER_PAGE)).then(
    () => undefined,
    () => undefined,
  );
}
