import { describe, expect, it } from 'vitest';
import { normalizeSerialWorkKey, parseSerialReleaseName } from './serial-release-name';

describe('serial release filename parser', () => {
  it.each([
    ['합성의 봄 12화.cbz', '합성의 봄', 'c:12', '12화'],
    ['합성의 봄 제012.5화.zip', '합성의 봄', 'c:12.5', '12.5화'],
    ['합성의 봄 12~13화.zip', '합성의 봄', 'c:12-13', '12-13화'],
    ['합성의 봄 3권.cbz', '합성의 봄', 'v:3', '3권'],
    ['합성의 봄 1권 12화.cbz', '합성의 봄', 'v:1/c:12', '1권 12화'],
    ['합성의 봄 외전 2화.cbz', '합성의 봄', 'special:extra/c:2', '외전 2화'],
    ['作品名 第2巻 第12話.zip', '作品名', 'v:2/c:12', '2권 12화'],
    ['Title Chapter 012 [Digital].cbz', 'Title', 'c:12', '12화'],
    ['Title v01 c012.zip', 'Title', 'v:1/c:12', '1권 12화'],
    ['Title S02E03.zip', 'Title', 's:2/c:3', '시즌 2 3화'],
  ])('extracts %s', (fileName, title, releaseKey, releaseTitle) => {
    expect(parseSerialReleaseName(fileName)).toMatchObject({
      workTitle: title,
      normalizedWorkKey: normalizeSerialWorkKey(title),
      releaseKey,
      releaseTitle,
      confidence: 'high',
    });
  });

  it('uses the parent package title only for a bare numeric child', () => {
    expect(parseSerialReleaseName('001.cbz', '합성의 봄.zip')).toMatchObject({
      workTitle: '합성의 봄',
      releaseKey: 'c:1',
      confidence: 'medium',
    });
    expect(parseSerialReleaseName('001.cbz')).toMatchObject({
      workTitle: '001',
      releaseKey: undefined,
      confidence: 'low',
    });
    expect(parseSerialReleaseName('합성의 봄 003.cbz', '합성의 봄')).toMatchObject({
      workTitle: '합성의 봄',
      releaseKey: 'c:3',
      confidence: 'medium',
    });
    expect(parseSerialReleaseName('합성의 봄 001-020.zip')).toMatchObject({
      workTitle: '합성의 봄',
      releaseKey: 'c:1-20',
      confidence: 'medium',
    });
  });

  it.each(['2073.cbz', '27 01.cbz', '23rd Synthetic Voyage.cbz', 'Title v2 final.cbz', '2026-08-26.cbz'])(
    'does not turn an ambiguous number into a release for %s',
    (fileName) => {
      expect(parseSerialReleaseName(fileName).releaseKey).toBeUndefined();
    },
  );

  it('keeps bracketed titles unless the trailing group is recognized noise', () => {
    expect(parseSerialReleaseName('[가상의 인물] 12화 [KOR].cbz')).toMatchObject({
      workTitle: '[가상의 인물]',
      releaseKey: 'c:12',
    });
  });

  it.each([
    ['합성 항해일지 1-315 完.txt', '합성 항해일지', 'c:1-315', 'complete'],
    ['가상 독서 기록 1~551화 [완결].txt', '가상 독서 기록', 'c:1-551', 'complete'],
    ['합성연대기 총 1800화 연재중.txt', '합성연대기', undefined, 'ongoing'],
    ['[텍본] 합성 항해일지 1-315 (완).txt.zip', '합성 항해일지', 'c:1-315', 'complete'],
    ['2X73 1권.epub', '2X73', 'v:1', undefined],
    ['27 -샘플번호- 1권.epub', '27 -샘플번호', 'v:1', undefined],
  ])('extracts catalog titles from distribution-style name %s', (fileName, title, releaseKey, completion) => {
    expect(parseSerialReleaseName(fileName)).toMatchObject({
      workTitle: title,
      releaseKey,
      completion,
    });
  });

  it.each(['제8합성국.txt', '2073.txt', '2026-08-26.zip', '[가상의 인물].epub'])(
    'preserves a numeric or bracketed work title for %s',
    (fileName) => {
      const parsed = parseSerialReleaseName(fileName);
      expect(parsed.releaseKey).toBeUndefined();
      expect(parsed.workTitle).toBe(fileName.replace(/\.(?:txt|epub|zip)$/u, ''));
    },
  );

  it('keeps volume, chapter and special namespaces distinct', () => {
    expect(parseSerialReleaseName('작품 1권.cbz').releaseKey).not.toBe(
      parseSerialReleaseName('작품 1화.cbz').releaseKey,
    );
    expect(parseSerialReleaseName('작품 외전 1화.cbz').releaseKey).not.toBe(
      parseSerialReleaseName('작품 1화.cbz').releaseKey,
    );
  });

  it('strips an OS duplicate suffix only for an explicit catalog source filename', () => {
    expect(
      parseSerialReleaseName('요정은 구름을 키운다 완 (1).txt', undefined, {
        stripFileCopySuffix: true,
      }),
    ).toMatchObject({
      workTitle: '요정은 구름을 키운다',
      completion: 'complete',
      confidence: 'low',
      evidence: ['file_copy_suffix', 'completion:complete'],
    });
    expect(
      parseSerialReleaseName('[텍본] 합성 항해일지 1-315 完 (2).txt.zip', undefined, {
        stripFileCopySuffix: true,
      }),
    ).toMatchObject({
      workTitle: '합성 항해일지',
      releaseKey: 'c:1-315',
      completion: 'complete',
    });
  });

  it('preserves a meaningful parenthesized number outside the source-copy boundary', () => {
    expect(parseSerialReleaseName('작품 (1).txt').workTitle).toBe('작품 (1)');
    expect(parseSerialReleaseName('작품 (1) 2화.txt', undefined, { stripFileCopySuffix: true })).toMatchObject({
      workTitle: '작품 (1)',
      releaseKey: 'c:2',
    });
    expect(parseSerialReleaseName('작품 (01).txt', undefined, { stripFileCopySuffix: true }).workTitle).toBe(
      '작품 (01)',
    );
  });
});
