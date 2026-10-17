import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testChapter, testNovel, testPosition } from '../../features/book-workspace/book-workspace-test-fixtures';
import { getItem, putItem } from '../../storage/indexeddb-transaction';
import { resetReaderDbForTests } from '../../storage/reader-database';
import { getNovel, getNovels } from '../../storage/reader-query-store';
import { clearReadingPosition, patchNovelMetadata, saveReadingPosition } from '../../storage/reader-state-store';
import type { Novel } from '../../domain/types';
import { actions, model } from '../test-fixtures';
import { createUiNextHomeAdapter } from './model';

const now = Date.parse('2026-10-15T12:00:00Z');
function home(novels: Novel[]) {
  const library = model(novels);
  return createUiNextHomeAdapter(
    { model: library, actions: actions() },
    {
      books: library.collection.visibleBooks,
      externalWorks: [],
      memberships: [],
      now,
      setConfig: vi.fn(),
      navigation: { openLibraryRoot: vi.fn(), openDiscovery: vi.fn() },
    },
  );
}
beforeEach(async () => {
  await resetReaderDbForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

it('projects local position saves into recent library order and home labels after returning or reloading', async () => {
  for (let index = 1; index <= 3; index++) {
    const id = `local-${index}`;
    await putItem('novels', testNovel({ id, title: id }));
    await putItem('chapters', testChapter(1, { id: `chapter-${id}`, novelId: id }));
    vi.setSystemTime(now - (4 - index) * 60_000);
    await saveReadingPosition({
      novelId: id,
      chapterId: `chapter-${id}`,
      paragraphIndex: 1,
      chapterProgress: 0.2,
      scrollTop: 10,
    });
    expect((await getNovel(id))!.lastReadAt).toBe(new Date().toISOString());
    expect((await getItem<Novel>('novels', id))!.lastReadAt).toBe(new Date().toISOString());
  }
  vi.setSystemTime(now);
  await patchNovelMetadata('local-1', { title: '수정한 제목' });
  const novels = await getNovels();
  expect(model(novels).collection.visibleBooks.map((book) => book.novel.id)).toEqual(['local-3', 'local-2', 'local-1']);
  expect(home(novels).hero.map((item) => [item.item.key, item.lastReadLabel])).toEqual([
    ['book:local-3', '1분 전'],
    ['book:local-2', '2분 전'],
    ['book:local-1', '3분 전'],
  ]);
});

it('recovers older local records from persisted positions without using metadata edit timestamps', async () => {
  await putItem('novels', testNovel({ id: 'legacy', updatedAt: new Date(now).toISOString(), lastReadProgress: 0.2 }));
  await putItem(
    'reading_positions',
    testPosition({ novelId: 'legacy', updatedAt: new Date(now - 3_600_000).toISOString() }),
  );
  expect((await getNovel('legacy'))!.lastReadAt).toBe(new Date(now - 3_600_000).toISOString());
  expect(home(await getNovels()).hero[0].lastReadLabel).toBe('1시간 전');
  // Query hydration does not rewrite historical metadata.
  expect((await getItem<Novel>('novels', 'legacy'))!.lastReadAt).toBeUndefined();
  await putItem('novels', testNovel({ id: 'legacy', lastReadAt: new Date(now - 60_000).toISOString() }));
  expect(home(await getNovels()).hero[0].lastReadLabel).toBe('1분 전');
  await clearReadingPosition('legacy');
  expect((await getNovel('legacy'))!.lastReadAt).toBeUndefined();
  expect(home(await getNovels()).hero[0].reason).toBe('new');
});

it('preserves the missing-timestamp fallback and ignores invalid position dates', async () => {
  await putItem('novels', testNovel({ lastReadProgress: 0.2, updatedAt: new Date(now).toISOString() }));
  await putItem('reading_positions', testPosition({ updatedAt: 'invalid' }));
  expect((await getNovel('book-1'))!.lastReadAt).toBeUndefined();
  expect(home(await getNovels()).hero[0]).toMatchObject({ reason: 'continue', lastReadLabel: '' });
});
