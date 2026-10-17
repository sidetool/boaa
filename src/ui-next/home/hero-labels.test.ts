import { describe, expect, it } from 'vitest';
import { relativeLastReadLabel, bookHeroLabels } from './hero-labels';
import { model, novel } from '../test-fixtures';

describe('hero labels', () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  it.each([
    [0, '방금'],
    [59_000, '방금'],
    [60_000, '1분 전'],
    [59 * 60_000, '59분 전'],
    [3600_000, '1시간 전'],
    [23 * 3600_000, '23시간 전'],
    [24 * 3600_000, '어제'],
    [3 * 86400_000, '3일 전'],
    [7 * 86400_000, '10월 8일'],
  ] as const)('formats elapsed %s using the shared activity timestamp', (elapsed, expected) => {
    expect(relativeLastReadLabel(now - elapsed, now)).toBe(expected);
  });
  it('leaves unknown times blank and clamps future clock skew', () => {
    expect(relativeLastReadLabel(0, now)).toBe('');
    expect(relativeLastReadLabel(NaN, now)).toBe('');
    expect(relativeLastReadLabel(now + 60_000, now)).toBe('방금');
  });
  it('uses available chapter titles and preserves document labels', () => {
    const book = model([novel({ lastReadAt: '2026-10-14', lastReadChapterIndex: 3, totalChapters: 12 })]).collection
      .visibleBooks[0];
    expect(bookHeroLabels(book, 'continue', { index: 3, title: '제3화 장면 3' })).toEqual({
      positionLabel: '3화 · 제3화 장면 3',
      resumeLabel: '3화 이어 읽기',
    });
    expect(bookHeroLabels(book, 'continue')).toEqual({ positionLabel: '3화 / 12화', resumeLabel: '3화 이어 읽기' });
    book.novel.format = 'pdf';
    expect(bookHeroLabels(book, 'continue', { index: 3, title: '제목' })).toEqual({
      positionLabel: book.readingPositionLabel,
      resumeLabel: book.directActionLabel,
    });
  });
});

describe('source episode hero labels', () => {
  it.each([undefined, '', '   ', '6화', ' 6 화 ', '6'])(
    'uses the source total for redundant episode title %j',
    (episodeTitle) => {
      const book = model([novel({ lastReadAt: '2026-10-14', lastReadChapterIndex: 2, totalChapters: 3 })]).collection
        .visibleBooks[0];
      book.sourcePosition = { episodeNumber: 6, episodeTitle, position: 6, total: 72, progress: 6 / 72 };
      // Stored chapter and saved-book counts differ from the actual source position and catalogue size.
      expect(bookHeroLabels(book, 'continue', { index: 2, title: '저장된 회차' })).toEqual({
        positionLabel: '6화 / 72화',
        resumeLabel: '6화 이어 읽기',
      });
    },
  );
  it('keeps a meaningful source episode title without the total suffix', () => {
    const book = model([novel({ totalChapters: 3 })]).collection.visibleBooks[0];
    book.sourcePosition = {
      episodeNumber: 6,
      episodeTitle: '  새로운 장면  ',
      position: 6,
      total: 72,
      progress: 6 / 72,
    };
    expect(bookHeroLabels(book, 'continue')).toEqual({
      positionLabel: '6화 · 새로운 장면',
      resumeLabel: '6화 이어 읽기',
    });
  });
});
