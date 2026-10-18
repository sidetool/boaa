import { expect, it } from 'vitest';
import { buildPlainTTSBatch } from './plain-tts';
import { estimatedPlainTTSParagraph } from './plain-tts-progress';
it('follows weighted source paragraphs without assuming contiguous indices or changing the resume fingerprint', () => {
  const paragraphs = ['가'.repeat(10), '나'.repeat(30)].map((text, i) => ({
    id: `p${i}`,
    novelId: 'b',
    chapterId: 'c',
    index: i * 3 + 1,
    text,
    textHash: `h${i}`,
    startOffsetInChapter: 0,
    endOffsetInChapter: text.length,
  }));
  const batch = buildPlainTTSBatch({ paragraphs, rate: 1 })!;
  expect(estimatedPlainTTSParagraph(batch, 0)?.paragraphId).toBe('p0');
  expect(estimatedPlainTTSParagraph(batch, 0.24)?.paragraphId).toBe('p0');
  expect(estimatedPlainTTSParagraph(batch, 0.3)?.paragraphIndex).toBe(3);
  expect(estimatedPlainTTSParagraph(batch, 1)?.paragraphId).toBe('p1');
  expect(estimatedPlainTTSParagraph(batch, NaN)).toBeUndefined();
  expect(batch.plainBatch?.[0].paragraphId).toBe('p0');
});
