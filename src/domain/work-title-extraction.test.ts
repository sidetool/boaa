import { describe, expect, it } from 'vitest';
import { extractWorkTitle } from './work-title-extraction';

describe('work title extraction', () => {
  it.each([
    '합성요정ㄴ은 산책하고 싶다',
    '합성요정ㄴ은 산책하고 싶다'.normalize('NFKC'),
    '합성요정ㄴ은 산책하고 싶다'.normalize('NFD'),
  ])('preserves standalone Hangul in catalog queries from %s', (title) => {
    expect(extractWorkTitle(title).queryCandidates).toEqual(['합성요정ㄴ은 산책하고 싶다']);
    expect(extractWorkTitle(`${title} １－２００ 完.txt`).canonicalTitle).toBe('합성요정ㄴ은 산책하고 싶다');
  });
  it('uses the canonical work title first and preserves the imported title as fallback', () => {
    expect(extractWorkTitle('합성 항해일지 1-315 完')).toMatchObject({
      originalTitle: '합성 항해일지 1-315 完',
      canonicalTitle: '합성 항해일지',
      queryCandidates: ['합성 항해일지', '합성 항해일지 1-315 完'],
      parsed: {
        releaseKey: 'c:1-315',
        completion: 'complete',
      },
    });
  });

  it('uses a source filename as an additional hint without overriding a curated title', () => {
    expect(extractWorkTitle('합성 항해일지', '[텍본] 합성 항해일지 1-315 完.txt').queryCandidates).toEqual([
      '합성 항해일지',
    ]);
    expect(extractWorkTitle('별칭', '합성 항해일지 1-315 完.txt').queryCandidates).toEqual(['별칭', '합성 항해일지']);
  });

  it.each(['2073', '제8합성국', '23rd Synthetic Voyage', '2026-08-26', '[가상의 인물]'])(
    'does not strip meaningful title content from %s',
    (title) => {
      expect(extractWorkTitle(title)).toMatchObject({
        canonicalTitle: title,
        queryCandidates: [title],
      });
    },
  );

  it('uses an OS-copy-cleaned source filename only as the leading catalog query', () => {
    expect(extractWorkTitle('요정은 구름을 키운다 완 (1)', '요정은 구름을 키운다 완 (1).txt')).toMatchObject({
      originalTitle: '요정은 구름을 키운다 완 (1)',
      canonicalTitle: '요정은 구름을 키운다',
      queryCandidates: ['요정은 구름을 키운다', '요정은 구름을 키운다 완 (1)'],
      evidence: expect.arrayContaining(['file_copy_suffix', 'completion:complete', 'title_cleanup']),
    });
  });

  it('does not let a copied source filename override a curated title or a meaningful chapter marker', () => {
    expect(extractWorkTitle('별칭', '요정은 구름을 키운다 완 (1).txt').queryCandidates).toEqual([
      '별칭',
      '요정은 구름을 키운다',
    ]);
    expect(extractWorkTitle('작품 (1)', '작품 (1) 2화.txt')).toMatchObject({
      canonicalTitle: '작품 (1)',
      queryCandidates: ['작품 (1)'],
    });
  });
});
