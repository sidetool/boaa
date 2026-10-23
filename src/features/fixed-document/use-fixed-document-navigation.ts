import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chapter, ListeningPosition, ReadingPosition } from '../../domain/types';
import { useFixedDocumentEntry, useFixedDocumentPageAnchor } from './use-fixed-document-entry';

export function clampFixedDocumentPage(page: number, total: number): number {
  return Math.max(0, Math.min(Math.max(0, total - 1), Math.floor(page)));
}
function initialPage(
  chapters: readonly Chapter[],
  position?: Pick<ReadingPosition, 'chapterId'>,
  chapterId?: string,
): number {
  return Math.max(
    0,
    chapters.findIndex((chapter) => chapter.id === (chapterId ?? position?.chapterId)),
  );
}

/** Owns logical navigation. Viewport scrolling is an output; observed scrolling never requests another scroll. */
export function useFixedDocumentNavigation(input: {
  bookId: string;
  chapters: readonly Chapter[];
  readingPosition?: Pick<ReadingPosition, 'chapterId'>;
  initialChapterId?: string;
  entryRequestVersion?: number;
  listeningPosition?: Pick<ListeningPosition, 'anchor'>;
  onNavigate(page: number): void;
  preserveNativeAnchor?: () => boolean;
}) {
  const latest = useRef(input);
  latest.current = input;
  const [position, setPosition] = useState(() => {
    const pageIndex = initialPage(input.chapters, input.readingPosition, input.initialChapterId);
    return {
      pageIndex,
      pageDraft: String(pageIndex + 1),
      chapterId: input.chapters[pageIndex]?.id,
      chapters: input.chapters,
    };
  });
  const goToPage = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const pageIndex = clampFixedDocumentPage(next, latest.current.chapters.length);
    setPosition({
      pageIndex,
      pageDraft: String(pageIndex + 1),
      chapterId: latest.current.chapters[pageIndex]?.id,
      chapters: latest.current.chapters,
    });
    latest.current.onNavigate(pageIndex);
  }, []);
  const observePage = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const pageIndex = clampFixedDocumentPage(next, latest.current.chapters.length);
    setPosition((current) =>
      current.pageIndex === pageIndex && current.chapters === latest.current.chapters
        ? current
        : {
            pageIndex,
            pageDraft: String(pageIndex + 1),
            chapterId: latest.current.chapters[pageIndex]?.id,
            chapters: latest.current.chapters,
          },
    );
  }, []);
  const setPageDraft = useCallback((pageDraft: string) => setPosition((current) => ({ ...current, pageDraft })), []);
  const previousBook = useRef(input.bookId);
  useLayoutEffect(() => {
    if (previousBook.current === input.bookId) return;
    previousBook.current = input.bookId;
    // Explicit chapter requests are applied by the entry owner below.
    if (!input.initialChapterId) goToPage(initialPage(input.chapters, input.readingPosition));
  }, [input.bookId, input.initialChapterId, input.chapters, input.readingPosition, goToPage]);
  useFixedDocumentEntry(input.bookId, input.initialChapterId, input.chapters, goToPage, input.entryRequestVersion);
  const reindexPage = useCallback(
    (index: number) => {
      if (latest.current.preserveNativeAnchor?.()) observePage(index);
      else goToPage(index);
    },
    [goToPage, observePage],
  );
  useFixedDocumentPageAnchor(input.bookId, input.chapters, position.pageIndex, reindexPage);
  useEffect(() => {
    const anchor = input.listeningPosition?.anchor;
    if (anchor?.kind === 'fixed_text' && anchor.bookId === input.bookId) goToPage(anchor.pageIndex);
  }, [goToPage, input.listeningPosition, input.bookId]);
  const remapped =
    position.chapters !== input.chapters && position.chapterId
      ? input.chapters.findIndex((chapter) => chapter.id === position.chapterId)
      : position.pageIndex;
  const pageIndex = remapped >= 0 ? remapped : position.pageIndex;
  useLayoutEffect(() => {
    if (position.chapters !== input.chapters)
      setPosition((current) => ({
        ...current,
        chapters: input.chapters,
        chapterId: input.chapters[pageIndex]?.id,
        pageIndex,
        pageDraft: String(pageIndex + 1),
      }));
  }, [input.chapters, position.chapters, pageIndex]);
  return {
    pageIndex,
    pageDraft: pageIndex === position.pageIndex ? position.pageDraft : String(pageIndex + 1),
    goToPage,
    observePage,
    setPageDraft,
  };
}
