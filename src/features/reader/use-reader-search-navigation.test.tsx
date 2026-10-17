import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, Paragraph } from '../../domain/types';
import type { ReaderQueries } from '../../repositories/reader-repository';
import { useReaderSearch } from './use-reader-search';

const chapters: Chapter[] = ['a', 'b'].map((id, index) => ({
  id,
  novelId: 'book',
  index: index + 1,
  title: id,
  normalizedText: '',
  textHash: id,
  rawStartOffset: 0,
  rawEndOffset: 20,
  characterCount: 20,
  paragraphCount: 2,
  createdAt: '',
  updatedAt: '',
}));
const paragraphs: Paragraph[] = ['a', 'a', 'b', 'b'].map((chapterId, index) => ({
  id: `p${index}`,
  novelId: 'book',
  chapterId,
  index: (index % 2) + 1,
  text: 'needle 본문',
  startOffsetInChapter: 0,
  endOffsetInChapter: 9,
  textHash: `p${index}`,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('search navigation between chapters', () => {
  it.each(['book', 'chapter'] as const)('keeps the correct query identity for %s scope', async (scope) => {
    const searchParagraphPage = vi.fn<ReaderQueries['searchParagraphPage']>(async (request) => ({
      paragraphs: request.scope === 'book' ? paragraphs : paragraphs.filter((p) => p.chapterId === request.chapterId),
      capped: false,
      scannedRows: 4,
      scannedTextCharacters: 36,
    }));
    const repository = { searchParagraphPage } as unknown as ReaderQueries;
    const scrollToParagraph = vi.fn(async () => true);
    const notify = vi.fn();
    let search!: ReturnType<typeof useReaderSearch>;
    let renderer!: ReactTestRenderer;
    const openChapter = vi.fn(async (chapter: Chapter) => renderer.update(<Probe chapter={chapter} />));
    function Probe({ chapter }: { chapter: Chapter }) {
      search = useReaderSearch({
        repository,
        novel: { id: 'book' },
        chapter,
        chapters,
        scrollToParagraph,
        openChapter,
        notify,
      });
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Probe chapter={chapters[0]} />);
      });
      await act(async () => {
        search.setScope(scope);
        search.setQuery('needle');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      if (scope === 'book') {
        await act(async () => search.goToResult(paragraphs[2], 2));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(searchParagraphPage).toHaveBeenCalledTimes(1);
        expect(search.cursor).toBe(2);
        await act(async () => search.jump(1));
        expect(search.cursor).toBe(3);
        expect(scrollToParagraph).toHaveBeenLastCalledWith('p3');
        expect(openChapter).toHaveBeenCalledTimes(1);
      } else {
        await act(async () => renderer.update(<Probe chapter={chapters[1]} />));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(searchParagraphPage).toHaveBeenCalledTimes(2);
        expect(search.matches.map((p) => p.id)).toEqual(['p2', 'p3']);
        expect(search.cursor).toBe(0);
      }
    } finally {
      act(() => renderer?.unmount());
    }
  });
});

it('uses result data for same-chapter jumps and ignores an older chapter lookup after clearing', async () => {
  const scrollToMatch = vi.fn(async () => true);
  const scrollToParagraph = vi.fn(async () => true);
  let resolveChapter!: (chapter: Chapter) => void;
  const repository = {
    searchParagraphPage: vi.fn(async () => ({ paragraphs, capped: false })),
    getChapter: vi.fn(
      () =>
        new Promise<Chapter>((resolve) => {
          resolveChapter = resolve;
        }),
    ),
  } as unknown as ReaderQueries;
  const openChapter = vi.fn(async () => {}),
    notify = vi.fn();
  let search!: ReturnType<typeof useReaderSearch>;
  function Probe() {
    search = useReaderSearch({
      repository,
      novel: { id: 'book' },
      chapter: chapters[0],
      chapters: [chapters[0]],
      scrollToParagraph,
      scrollToMatch,
      openChapter,
      notify,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  try {
    act(() => {
      search.setScope('book');
      search.setQuery('needle');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {
      await search.goToResult(paragraphs[1], 1);
    });
    expect(scrollToMatch).toHaveBeenCalledWith(paragraphs[1]);
    expect(scrollToParagraph).not.toHaveBeenCalled();
    let pending!: Promise<void>;
    act(() => {
      pending = search.goToResult(paragraphs[2], 2);
    });
    act(() => search.clear());
    await act(async () => {
      resolveChapter(chapters[1]);
      await pending;
    });
    expect(openChapter).not.toHaveBeenCalled();
    expect(search.query).toBe('');
    expect(search.cursor).toBe(0);
  } finally {
    act(() => renderer.unmount());
  }
});

it('advances rapid next clicks from the latest cursor and fences late cross-chapter completion', async () => {
  const pending: (() => void)[] = [];
  const openChapter = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
  const repository = {
    searchParagraphPage: vi.fn(async () => ({ paragraphs, capped: false })),
  } as unknown as ReaderQueries;
  const scrollToParagraph = vi.fn(async () => true),
    notify = vi.fn();
  let search!: ReturnType<typeof useReaderSearch>;
  function Probe() {
    search = useReaderSearch({
      repository,
      novel: { id: 'book' },
      chapter: chapters[0],
      chapters,
      scrollToParagraph,
      openChapter,
      notify,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  try {
    act(() => {
      search.setScope('book');
      search.setQuery('needle');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      void search.jump(1);
      first = search.jump(1);
      second = search.jump(1);
    });
    expect(openChapter).toHaveBeenNthCalledWith(
      1,
      chapters[1],
      expect.objectContaining({ preserveSearch: true, position: expect.objectContaining({ paragraphId: 'p2' }) }),
    );
    expect(openChapter).toHaveBeenNthCalledWith(
      2,
      chapters[1],
      expect.objectContaining({ position: expect.objectContaining({ paragraphId: 'p3' }) }),
    );
    await act(async () => {
      pending[1]();
      await second;
      pending[0]();
      await first;
    });
    expect(search.cursor).toBe(3);
  } finally {
    act(() => renderer.unmount());
  }
});
