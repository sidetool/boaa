import { usePdfTaskOwner } from './use-pdf-task-owner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentTextRepository, DocumentTextSearchResult } from '../../repositories/document-text-repository';
export function usePdfTextSearch(input: {
  bookId: string;
  scope: string;
  open: boolean;
  version: number;
  readyPages: number;
  repository: Pick<DocumentTextRepository, 'search'>;
  goToPage(page: number): void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const { owner, capture } = usePdfTaskOwner(
    JSON.stringify([input.bookId, input.scope, input.open, input.version, input.readyPages, searchQuery]),
    input.repository,
  );
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; results: DocumentTextSearchResult[] }>();
  const searchResults = useMemo(() => (snapshot?.owner === owner ? snapshot.results : []), [snapshot, owner]);
  const [searchCursor, setCursor] = useState(0);
  const [searchStatus, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const go = useRef(input.goToPage);
  go.current = input.goToPage;
  useEffect(() => {
    const current = capture();
    const query = searchQuery.trim();
    if (!input.open || !query) {
      setStatus('idle');
      setSnapshot({ owner, results: [] });
      setCursor(0);
      return;
    }
    let active = true;
    setStatus('loading');
    const timer = setTimeout(() => {
      void input.repository
        .search(input.bookId, query)
        .then((results) => {
          if (!active || !current()) return;
          setSnapshot({ owner, results });
          setCursor(0);
          setStatus('ready');
          if (results[0]) go.current(results[0].pageIndex);
        })
        .catch(() => {
          if (active && current()) setStatus('failed');
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    input.bookId,
    input.scope,
    input.open,
    input.version,
    input.readyPages,
    input.repository,
    searchQuery,
    owner,
    capture,
  ]);
  const jumpToSearchResult = useCallback(
    (index: number) => {
      if (!capture()() || !searchResults.length) return;
      const normalized = (index + searchResults.length) % searchResults.length;
      setCursor(normalized);
      go.current(searchResults[normalized].pageIndex);
    },
    [searchResults, capture],
  );
  return { searchQuery, setSearchQuery, searchResults, searchCursor, searchStatus, jumpToSearchResult };
}
