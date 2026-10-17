import { expect, it } from 'vitest';
import { testChapter, testPosition } from '../book-workspace/book-workspace-test-fixtures';
import { fixedDocumentPosition } from './fixed-document-position';
it('restores the precise fraction only for the saved chapter', () => {
  const chapter = testChapter(2);
  const position = testPosition({ chapterId: chapter.id, offsetInParagraph: 420_000 });
  expect(fixedDocumentPosition([testChapter(1), chapter], position)).toEqual({ page: 1, fraction: 0.42, ratio: 1.5 });
  expect(fixedDocumentPosition([chapter], position, 'another-page')).toBeUndefined();
  expect(fixedDocumentPosition([chapter], { ...position, offsetInParagraph: 0, chapterProgress: 1 })?.fraction).toBe(0);
});
