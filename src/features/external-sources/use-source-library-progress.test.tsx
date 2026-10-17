import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useSourceLibraryProgress } from './use-source-library-progress';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';

it('does not rescan library chapters after background imports while reading, then resumes on exit', async () => {
  const listChapters = vi.fn(async () => []);
  const options = {
    registry: { getExternalSourceStatus: () => ({ state: 'connected' }) },
    state: {
      getCachePage: vi.fn(async () => ({ completeSeries: true, items: [{ release: { title: 'Synthetic' } }] })),
    },
  } as unknown as UseExternalSourceControllerOptions;
  const books = ['a', 'b'].map((id) => testNovel({ id, format: 'txt' }));
  function Probe({ reading, revision }: { reading: boolean; revision: string }) {
    useSourceLibraryProgress(
      { ...options, readingActive: reading },
      {
        novels: books.map((book) => ({ ...book, activeContentRevisionId: revision })),
        links: books.map((book) => ({
          id: book.id,
          source: { connectorId: 'fixture.source', remoteId: book.id },
          localBookId: book.id,
          collectionRemoteId: book.id,
          linkedAt: '2026-01-01',
        })),
        subscriptions: [],
        preferences: [],
        listChapters,
      },
    );
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe reading revision="r1" />);
  });
  try {
    await act(async () => root.update(<Probe reading revision="r2" />));
    expect(listChapters).not.toHaveBeenCalled();
    expect(options.state.getCachePage).not.toHaveBeenCalled();
    await act(async () => root.update(<Probe reading={false} revision="r2" />));
    expect(listChapters.mock.calls).toEqual([['a'], ['b']]);
  } finally {
    act(() => root.unmount());
  }
});
