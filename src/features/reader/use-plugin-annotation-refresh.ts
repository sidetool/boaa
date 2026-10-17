import { useCallback, useLayoutEffect, useMemo } from 'react';
import type { AnnotationRepository } from '../../repositories/reader-repository';
import type { Bookmark, ReaderHighlight, ReaderNote } from '../../domain/types';

export interface PluginAnnotationRefreshPorts {
  readonly repository: Pick<AnnotationRepository, 'listBookmarks' | 'listHighlights' | 'listNotes'>;
  readonly setBookmarks: (value: Bookmark[]) => void;
  readonly setHighlights: (value: ReaderHighlight[]) => void;
  readonly setNotes: (value: ReaderNote[]) => void;
  readonly notify: (message: string) => void;
}

/** Reloads committed plugin annotations; only the latest request in this Reader revision may publish. */
export function usePluginAnnotationRefresh(
  bookId: string,
  contentRevision: string | undefined,
  { repository, setBookmarks, setHighlights, setNotes, notify }: PluginAnnotationRefreshPorts,
) {
  const scope = useMemo(
    () => ({ active: false, request: 0, bookId, contentRevision, repository }),
    [bookId, contentRevision, repository],
  );
  useLayoutEffect(() => {
    scope.active = true;
    scope.request++;
    return () => {
      scope.active = false;
      scope.request++;
    };
  }, [scope]);
  return useCallback(() => {
    if (!scope.active) return;
    const request = ++scope.request;
    void Promise.all([
      repository.listBookmarks(bookId),
      repository.listHighlights(bookId),
      repository.listNotes(bookId),
    ])
      .then(([bookmarks, highlights, notes]) => {
        if (!scope.active || scope.request !== request) return;
        setBookmarks(bookmarks);
        setHighlights(highlights);
        setNotes(notes);
      })
      .catch(() => {
        if (scope.active && scope.request === request)
          notify('주석은 저장됐지만 화면 갱신에 실패했습니다. 서재에서 책을 다시 열어 주세요.');
      });
  }, [bookId, scope, repository, setBookmarks, setHighlights, setNotes, notify]);
}
