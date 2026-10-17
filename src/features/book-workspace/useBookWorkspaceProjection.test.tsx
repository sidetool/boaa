import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { BookWorkspaceProjection } from './book-workspace-projection';
import { testChapter, testNovel, testPosition, testWorkspaceState } from './book-workspace-test-fixtures';
import { useBookWorkspaceProjection } from './useBookWorkspaceProjection';

describe('useBookWorkspaceProjection', () => {
  it('retains library and chapter projections when only reader session state changes', async () => {
    const novel = testNovel();
    const chapter = testChapter(1);
    let state = testWorkspaceState({ selectedNovel: novel, novels: [novel], chapters: [chapter] });
    const annotationCounts = new Map();
    let projection!: BookWorkspaceProjection;
    function Harness() {
      projection = useBookWorkspaceProjection(state, annotationCounts);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const libraryCollection = projection.libraryCollection;
    const chapterList = projection.chapterList;

    state = { ...state, readerProgress: 0.4, readerSessionDisplaySeconds: 12 };
    await act(async () => {
      renderer.update(<Harness />);
    });

    expect(projection.libraryCollection).toBe(libraryCollection);
    expect(projection.chapterList).toBe(chapterList);
    renderer.unmount();
  });
  it('keeps the outline and chapter list stable during paragraph progress, but updates the current chapter', async () => {
    const novel = testNovel();
    const chapters = [testChapter(1), testChapter(2)];
    let state = testWorkspaceState({
      selectedNovel: novel,
      novels: [novel],
      chapters,
      currentChapter: chapters[0],
      localReadingPosition: testPosition({
        novelId: novel.id,
        chapterId: chapters[0].id,
        paragraphId: 'paragraph-1',
        paragraphIndex: 1,
        offsetInParagraph: 0,
        chapterProgress: 0.1,
        scrollTop: 0,
        updatedAt: '2026-10-01T00:00:00Z',
      }),
    });
    let projection!: BookWorkspaceProjection;
    const counts = new Map();
    function Harness() {
      projection = useBookWorkspaceProjection(state, counts);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const chapterList = projection.chapterList;
    const outline = projection.filteredOutlineChapters;
    state = {
      ...state,
      localReadingPosition: {
        ...state.localReadingPosition!,
        paragraphId: 'paragraph-2',
        paragraphIndex: 2,
        chapterProgress: 0.3,
      },
    };
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(projection.readChapterProgress).toBe(0.3);
    expect(projection.chapterList).toBe(chapterList);
    expect(projection.filteredOutlineChapters).toBe(outline);
    state = { ...state, localReadingPosition: { ...state.localReadingPosition!, chapterId: chapters[1].id } };
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(projection.chapterList).not.toBe(chapterList);
    expect(projection.readChapter?.id).toBe(chapters[1].id);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('reuses book views across query/filter/sort and refreshes them after catalog updates', async () => {
    const first = testNovel({ id: 'first', title: 'Alpha', tags: ['needle'], favorite: true });
    const second = testNovel({ id: 'second', title: 'Beta' });
    let state = testWorkspaceState({ novels: [second, first], librarySort: 'title' });
    let projection!: BookWorkspaceProjection;
    const counts = new Map();
    function Harness() {
      projection = useBookWorkspaceProjection(state, counts);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    const initial = projection.libraryCollection;
    const refresh = async (patch: Partial<typeof state>) => {
      state = { ...state, ...patch };
      await act(async () => {
        renderer.update(<Harness />);
      });
    };
    await refresh({ libraryQuery: 'NEEDLE' });
    expect(projection.libraryCollection.visibleBooks.map((book) => book.novel.id)).toEqual(['first']);
    expect(projection.libraryCollection.booksByNovelId).toBe(initial.booksByNovelId);
    await refresh({ libraryQuery: '', libraryFilter: 'favorite', librarySort: 'recent' });
    expect(projection.libraryCollection.visibleBooks.map((book) => book.novel.id)).toEqual(['first']);
    expect(projection.libraryCollection.filterCounts).toBe(initial.filterCounts);
    expect(projection.libraryCollection.recentBooks).toBe(initial.recentBooks);

    const updated = { ...first, favorite: false, lastReadProgress: 1, lastReadAt: '2026-07-12T00:00:00Z' };
    await refresh({ novels: [second, updated], libraryFilter: 'finished' });
    expect(projection.libraryCollection.visibleBooks.map((book) => book.novel.id)).toEqual(['first']);
    expect(projection.libraryCollection.booksByNovelId).not.toBe(initial.booksByNovelId);
    expect(projection.libraryCollection.filterCounts.favorite).toBe(0);
    expect(projection.libraryCollection.filterCounts.finished).toBe(1);
    expect(projection.libraryCollection.featuredBook?.novel).toBe(updated);
    await refresh({ novels: [second, { ...updated, deletedAt: '2026-07-13T00:00:00Z' }], libraryFilter: 'trash' });
    expect(projection.libraryCollection.totalBooks).toBe(1);
    expect(projection.libraryCollection.filterCounts.trash).toBe(1);
    expect(projection.libraryCollection.visibleBooks.map((book) => book.novel.id)).toEqual(['first']);
    const outsideCatalog = testNovel({ id: 'outside', title: 'Selected outside catalog', lastReadProgress: 1 });
    await refresh({ selectedNovel: outsideCatalog });
    expect(projection.selectedNovelScreenBook?.novel).toBe(outsideCatalog);
    expect(projection.selectedNovelScreenBook?.isFinished).toBe(true);
    expect(projection.libraryCollection.booksByNovelId.has('outside')).toBe(false);
    await act(async () => {
      renderer.unmount();
    });
  });
});
