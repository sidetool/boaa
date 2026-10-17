import { expect, it } from 'vitest';
import { testChapter, testPosition } from '../book-workspace/book-workspace-test-fixtures';
import { sourceChapterOpenOptions } from './source-chapter-open-options';
it('translates previous-at-end placeholders to the actual imported final paragraph', () => {
  const chapter = testChapter(6, { paragraphCount: 70, documentSectionId: 'episode' });
  const options = sourceChapterOpenOptions(
    {
      restore: true,
      position: testPosition({
        chapterId: 'source-pending:episode',
        paragraphIndex: 1,
        scrollTop: Number.MAX_SAFE_INTEGER,
      }),
    },
    chapter,
  );
  expect(options).toMatchObject({
    restore: true,
    position: { chapterId: chapter.id, paragraphIndex: 70 },
  });
});
it('retains an explicit in-chapter anchor while rebinding identity', () => {
  const chapter = testChapter(2);
  expect(
    sourceChapterOpenOptions(
      { restore: true, position: testPosition({ paragraphIndex: 4, offsetInParagraph: 25 }) },
      chapter,
    )?.position,
  ).toMatchObject({ chapterId: chapter.id, paragraphIndex: 4, offsetInParagraph: 25 });
});
