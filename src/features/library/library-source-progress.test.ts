import { describe, expect, it } from 'vitest';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { applySourceProgress, withSourceProgress } from './library-source-progress';
import { buildLibraryCollectionModel } from './library-screen-model';

const readState = { hasReadActivity: () => true, isFinished: () => false };

function collection() {
  return buildLibraryCollectionModel({
    novels: [
      testNovel({
        id: 'source-book',
        title: '소스 작품',
        totalChapters: 3,
        lastReadProgress: 1,
        lastReadAt: '2026-09-02',
      }),
      testNovel({
        id: 'local-book',
        title: '로컬 작품',
        totalChapters: 10,
        lastReadProgress: 0.4,
        lastReadAt: '2026-09-01',
      }),
    ],
    query: '',
    filter: 'all',
    sort: 'recent',
    readState,
  });
}

describe('applySourceProgress', () => {
  it('replaces downloaded progress for source works everywhere the library shows a book', () => {
    const progress = new Map([['source-book', { readCount: 3, totalCount: 120, progress: 3 / 120 }]]);
    const next = applySourceProgress(collection(), progress);
    const views = [
      next.visibleBooks.find((book) => book.novel.id === 'source-book'),
      next.recentBooks.find((book) => book.novel.id === 'source-book'),
      next.booksByNovelId.get('source-book'),
      next.featuredBook,
    ];

    views.forEach((book) => {
      expect(book?.bookProgress).toBeCloseTo(0.025);
      expect(book?.readingPositionLabel).toBe('3 / 120화');
      expect(book?.readingCounts).toEqual({ current: 3, total: 120, unit: '화' });
    });
    // One view per book keeps selection and focus comparisons stable.
    expect(new Set(views).size).toBe(1);
    expect(next.booksByNovelId.get('local-book')?.bookProgress).toBeCloseTo(0.4);
    expect(next.filterCounts).toEqual(collection().filterCounts);
  });

  it('returns the collection untouched when no source progress applies', () => {
    const base = collection();
    expect(applySourceProgress(base, undefined)).toBe(base);
    expect(applySourceProgress(base, new Map())).toBe(base);
  });
});

describe('withSourceProgress', () => {
  it('keeps the local book view when the work has no source progress', () => {
    const book = collection().visibleBooks[0]!;
    expect(withSourceProgress(book, undefined)).toBe(book);
  });
});

it.each([6, 40])(
  'reselects effective source position %i/40 before tabs and counts without changing resume data',
  (position) => {
    const novel = testNovel({ id: 'partial', totalChapters: 3, lastReadChapterIndex: 3, lastReadProgress: 1 });
    const selection = { query: '', filter: 'reading' as const, sort: 'recent' as const };
    const base = buildLibraryCollectionModel({
      novels: [novel],
      ...selection,
      readState: { hasReadActivity: () => true, isFinished: () => true },
    });
    expect(base.visibleBooks).toHaveLength(0);
    expect(applySourceProgress(base, undefined, selection).filterCounts.finished).toBe(1);
    const progress = new Map([
      [
        'partial',
        {
          readCount: position,
          totalCount: 40,
          progress: position / 40,
          sourcePosition: { episodeNumber: position, position, total: 40, progress: position / 40 },
        },
      ],
    ]);
    const reading = applySourceProgress(base, progress, selection);
    const finished = applySourceProgress(base, progress, { ...selection, filter: 'finished' });
    expect(reading.visibleBooks).toHaveLength(position === 6 ? 1 : 0);
    expect(finished.visibleBooks).toHaveLength(position === 40 ? 1 : 0);
    expect(reading.filterCounts.reading).toBe(position === 6 ? 1 : 0);
    expect(reading.filterCounts.finished).toBe(position === 40 ? 1 : 0);
    const view = reading.booksByNovelId.get('partial')!;
    expect(view.isFinished).toBe(position === 40);
    expect(view.readingStatusLabel).toBe(position === 40 ? '완독' : '읽는 중');
    expect(view.directActionLabel).toBe('이어 읽기');
    expect(view.bookProgress).toBe(position / 40);
    expect(withSourceProgress(base.booksByNovelId.get('partial')!, progress.get('partial'))).toEqual(view);
    expect(view.novel).toBe(novel);
    expect(novel.lastReadProgress).toBe(1);
  },
);

it('preserves completion semantics for source formats without sourcePosition', () => {
  const book = buildLibraryCollectionModel({
    novels: [testNovel()],
    query: '',
    filter: 'all',
    sort: 'recent',
    readState: { hasReadActivity: () => true, isFinished: () => true },
  }).visibleBooks[0]!;
  expect(withSourceProgress(book, { readCount: 2, totalCount: 40, progress: 0.05 }).isFinished).toBe(true);
});

it('preserves known local progress when only a visit and no source denominator is available', () => {
  const book = collection().visibleBooks[0]!;
  const result = withSourceProgress(book, { readCount: 0, totalCount: 0, progress: 0, lastReadAt: '2026-09-20' });
  expect(result.bookProgress).toBe(book.bookProgress);
  expect(result.readingCounts).toEqual(book.readingCounts);
  expect(result.activityAt).toBe('2026-09-20');
});
