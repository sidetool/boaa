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
}) {
  const latest = useRef(input);
  latest.current = input;
  const [position, setPosition] = useState(() => {
    const pageIndex = initialPage(input.chapters, input.readingPosition, input.initialChapterId);
    return { pageIndex, pageDraft: String(pageIndex + 1) };
  });
  const goToPage = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const pageIndex = clampFixedDocumentPage(next, latest.current.chapters.length);
    setPosition({ pageIndex, pageDraft: String(pageIndex + 1) });
    latest.current.onNavigate(pageIndex);
  }, []);
  const observePage = useCallback((next: number) => {
    if (!Number.isFinite(next)) return;
    const pageIndex = clampFixedDocumentPage(next, latest.current.chapters.length);
    setPosition((current) =>
      current.pageIndex === pageIndex ? current : { pageIndex, pageDraft: String(pageIndex + 1) },
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
  useFixedDocumentPageAnchor(input.bookId, input.chapters, position.pageIndex, goToPage);
  useEffect(() => {
    const anchor = input.listeningPosition?.anchor;
    if (anchor?.kind === 'fixed_text' && anchor.bookId === input.bookId) goToPage(anchor.pageIndex);
  }, [goToPage, input.listeningPosition, input.bookId]);
  return { ...position, goToPage, observePage, setPageDraft };
}
