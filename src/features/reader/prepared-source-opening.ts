import type { Chapter, Novel } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { ReaderOpenRequest } from './reader-screen-contract';
import { peekSharedParagraphPage } from './shared-paragraph-pages';

/** Only fresh source-chapter starts can bypass asynchronous position restoration.
 * Callers seed the viewport cache and acknowledge the same request sequence together.
 */
export function preparedSourceOpening(
  repository: ReaderBodyRepository,
  novel: Pick<Novel, 'id' | 'activeContentRevisionId'>,
  chapter: Pick<Chapter, 'id' | 'documentSectionId' | 'textHash' | 'paragraphCount'>,
  request: ReaderOpenRequest | undefined,
) {
  if (
    !chapter.documentSectionId ||
    request?.chapterId !== chapter.id ||
    request.restore ||
    request.targetParagraphId ||
    request.fallbackScrollTop
  )
    return;
  const revision =
    novel.activeContentRevisionId ?? `${novel.id}:${chapter.id}:${chapter.textHash}:${chapter.paragraphCount}`;
  const page = peekSharedParagraphPage(repository, revision, chapter.id, 0);
  // Require the opening runway, not merely a possibly incomplete cached response.
  if (
    !page ||
    Array.from({ length: Math.min(7, chapter.paragraphCount) }, (_, i) => i + 1).some(
      (index) => !page.paragraphs.some((p) => p.index === index),
    )
  )
    return;
  return page;
}
