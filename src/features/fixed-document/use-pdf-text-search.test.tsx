import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { deferred, repository } from './pdf-text-controller-test-fixtures';
import type { DocumentTextSearchResult } from '../../repositories/document-text-repository';
import { usePdfTextSearch } from './use-pdf-text-search';
const hit = (pageIndex: number): DocumentTextSearchResult => ({
  pageIndex,
  revisionId: 'r',
  blockId: 'b',
  text: 'Synthetic match',
  startOffset: 0,
  endOffset: 4,
  quads: [],
  source: 'pdf_native',
  blockOrder: 0,
});
afterEach(() => vi.useRealTimers());
it('rejects a late search across A→B→A and hides previous-scope hits immediately', async () => {
  vi.useFakeTimers();
  const repo = repository();
  const pending = deferred<DocumentTextSearchResult[]>();
  vi.mocked(repo.search)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue([hit(2)]);
  const go = vi.fn();
  let snapshot!: ReturnType<typeof usePdfTextSearch>;
  function Probe({ scope = 'A' }) {
    snapshot = usePdfTextSearch({
      bookId: scope,
      scope,
      open: true,
      version: 0,
      readyPages: 1,
      repository: repo,
      goToPage: go,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  act(() => snapshot.setSearchQuery('match'));
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  await act(async () => root.update(<Probe scope="B" />));
  await act(async () => root.update(<Probe />));
  await act(async () => {
    vi.advanceTimersByTime(180);
  });
  expect(snapshot.searchResults[0].pageIndex).toBe(2);
  await act(async () => {
    pending.resolve([hit(9)]);
    await pending.promise;
  });
  expect(go.mock.calls).toEqual([[2]]);
  await act(async () => root.update(<Probe scope="B" />));
  expect(snapshot.searchResults).toEqual([]);
  act(() => snapshot.jumpToSearchResult(0));
  expect(go).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
it('cancels the debounce on close and unmount', async () => {
  vi.useFakeTimers();
  const repo = repository();
  let snapshot!: ReturnType<typeof usePdfTextSearch>;
  function Probe({ open = true }) {
    snapshot = usePdfTextSearch({
      bookId: 'A',
      scope: 'A',
      open,
      version: 0,
      readyPages: 1,
      repository: repo,
      goToPage: vi.fn(),
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  act(() => snapshot.setSearchQuery('match'));
  await act(async () => root.update(<Probe open={false} />));
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  expect(repo.search).not.toHaveBeenCalled();
  await act(async () => root.update(<Probe />));
  act(() => root.unmount());
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  expect(repo.search).not.toHaveBeenCalled();
});
