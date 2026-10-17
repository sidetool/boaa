import { useMemo, useRef, useState, type RefObject } from 'react';
import type { Chapter, Novel, ReadingPosition } from '../../domain/types';
import { fixedDocumentPosition } from './fixed-document-position';
import { useComicViewportPosition, type ComicViewportPosition } from './use-comic-viewport-position';
import { useFixedDocumentProgress } from './use-fixed-document-progress';

/** Entry-scoped restoration and repository-scoped write ordering for saved and streamed pages. */
export function useFixedDocumentReadingPosition(input: {
  identity: string;
  novel: Novel;
  chapters: readonly Chapter[];
  page: number;
  ready: boolean;
  continuous: boolean;
  viewport: RefObject<HTMLElement>;
  content: RefObject<HTMLElement>;
  owner: object;
  readingPosition?: ReadingPosition;
  initialChapterId?: string;
  initial?: ComicViewportPosition;
  savePosition?: (position: ComicViewportPosition) => void;
  restorePage?: (page: number) => void;
  save: (page: number, chapter: Chapter, novel: Novel, position?: ComicViewportPosition) => void | Promise<void>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const entry = useMemo(() => {
    const current = latest.current;
    const initial =
      current.initial ?? fixedDocumentPosition(current.chapters, current.readingPosition, current.initialChapterId);
    return { identity: input.identity, initial, position: initial };
  }, [input.identity]);
  const [, render] = useState(0);
  useComicViewportPosition({
    ...input,
    initial: entry.initial,
    save: (position) => {
      entry.position = position;
      input.savePosition?.(position);
      render((value) => value + 1);
    },
  });
  const position = input.continuous ? entry.position : undefined;
  const page = position?.page ?? input.page;
  return useFixedDocumentProgress(
    page,
    input.chapters[page],
    input.novel,
    (pageIndex, chapter, novel, position) => {
      const resolvedPage = position?.page ?? pageIndex;
      return input.save(resolvedPage, input.chapters[resolvedPage] ?? chapter, novel, position);
    },
    {
      ready: input.ready,
      owner: input.owner,
      position,
      readPosition: () => (input.continuous ? entry.position : undefined),
    },
  );
}
