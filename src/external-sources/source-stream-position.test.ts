import { expect, it } from 'vitest';
import { testChapter, testNovel, testPosition } from '../features/book-workspace/book-workspace-test-fixtures';
import { latestSourceStreamPosition, savedSourceStreamPosition } from './source-stream-position';
it('restores work-wide progress within an episode and prefers the newest device or shared record', () => {
  const chapter = testChapter(8);
  const saved = savedSourceStreamPosition(
    testNovel({
      lastReadChapterId: chapter.id,
      lastReadProgress: 0.742,
      totalChapters: 10,
      lastReadAt: '2026-10-17T00:00:00Z',
    }),
    [testChapter(7), chapter],
    testPosition({ chapterId: chapter.id, offsetInParagraph: 420_000, updatedAt: '2026-10-17T00:00:00Z' }),
  );
  expect(saved?.page).toBe(1);
  expect(saved?.fraction).toBeCloseTo(0.42);
  const older = { ...saved!, page: 0, updatedAt: saved!.updatedAt - 1000 };
  expect(latestSourceStreamPosition(2, older, saved)).toBe(saved);
  expect(latestSourceStreamPosition(3, older, saved)).toBeUndefined();
});
it('does not restore a different episode or treat legacy complete pages as bottom anchors', () => {
  const chapter = testChapter(8);
  const novel = testNovel({
    lastReadChapterId: chapter.id,
    lastReadProgress: 0.8,
    totalChapters: 10,
    lastReadAt: '2026-10-17T00:00:00Z',
  });
  expect(savedSourceStreamPosition(novel, [testChapter(1)])).toBeUndefined();
  expect(savedSourceStreamPosition(novel, [chapter])?.fraction).toBe(0);
});
