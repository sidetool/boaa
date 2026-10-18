import { describe, expect, it } from 'vitest';
import type { Paragraph, SpokenTextRule } from '../domain/types';
import { buildPlainTTSBatch, preparePlainTTSBatch, buildPlainTTSItems, plainTTSParagraphHash } from './plain-tts';

function paragraph(text: string, extra: Partial<Paragraph> = {}): Paragraph {
  return {
    id: 'paragraph_plain',
    novelId: 'book_plain',
    chapterId: 'chapter_plain',
    index: 0,
    text,
    textHash: 'stored-hash-is-not-trusted',
    startOffsetInChapter: 0,
    endOffsetInChapter: text.length,
    ...extra,
  };
}

function rule(extra: Partial<SpokenTextRule>): SpokenTextRule {
  return {
    id: 'pronunciation',
    scope: 'global',
    kind: 'replace_literal',
    pattern: 'AI',
    replacement: '에이아이',
    enabled: true,
    priority: 0,
    updatedAt: '',
    ...extra,
  };
}

describe('plain paragraph TTS', () => {
  it('reads an unlabelled paragraph with no segment or character artifacts', () => {
    const source = paragraph('평범한 본문을 읽습니다. 다음 문장입니다.');
    const items = buildPlainTTSItems({ paragraph: source, rate: 1.2, voiceURI: 'M1' });
    expect(items.map((item) => item.text)).toEqual(['평범한 본문을 읽습니다.', '다음 문장입니다.']);
    for (const item of items) {
      expect(item).toMatchObject({
        paragraphId: source.id,
        speakerId: 'narrator',
        emotion: 'neutral',
        rate: 1.2,
        voiceURI: 'M1',
        sourceSegmentIds: [],
      });
      expect(item.spokenTextFingerprint).toBeTruthy();
      const range = item.sourceRanges[0];
      expect(range.paragraphId).toBe(source.id);
      expect(source.text.slice(range.startOffset, range.endOffset)).toBe(item.text);
      expect(item.sourceText).toBe(item.text);
    }
  });

  it('uses ruby readings and pronunciation rules while preserving original source offsets', () => {
    const source = paragraph('東京 AI 읽기.', {
      inlineSemantics: [{ start: 0, end: 2, kind: 'ruby', value: 'とうきょう' }],
    });
    const [item] = buildPlainTTSItems({ paragraph: source, language: 'ja', rules: [rule({})], rate: 1 });
    expect(item.text).toBe('とうきょう 에이아이 읽기.');
    expect(item.sourceText).toBe(source.text);
    expect(item.sourceRanges).toEqual([
      { segmentId: '', paragraphId: source.id, startOffset: 0, endOffset: source.text.length },
    ]);
  });

  it('honors skipped lines and footnote markers without requiring AI analysis', () => {
    expect(
      buildPlainTTSItems({
        paragraph: paragraph('[광고] 읽지 않을 문장'),
        rate: 1,
        rules: [rule({ kind: 'skip_prefix', pattern: '[광고]' })],
      }),
    ).toEqual([]);
    const source = paragraph('본문※', {
      inlineSemantics: [{ start: 2, end: 3, kind: 'footnote_reference', value: '#note' }],
    });
    expect(buildPlainTTSItems({ paragraph: source, rate: 1 })[0]).toMatchObject({ text: '본문', sourceText: '본문' });
  });

  it('chunks a long Unicode paragraph without dropping text or splitting surrogate pairs', () => {
    const text = `${'가𠀀🙂나'.repeat(180)}。！？「끝」\n마지막 문장!`;
    const source = paragraph(text);
    const items = buildPlainTTSItems({ paragraph: source, rate: 1 });
    expect(items.length).toBeGreaterThan(3);
    expect(
      items
        .map((item) => item.text)
        .join('')
        .replace(/\s/gu, ''),
    ).toBe(text.replace(/\s/gu, ''));
    for (const item of items) {
      expect(item.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      const [range] = item.sourceRanges;
      expect(range.startOffset).toBeGreaterThanOrEqual(0);
      expect(range.endOffset).toBeLessThanOrEqual(text.length);
      expect(item.sourceText).toBe(text.slice(range.startOffset, range.endOffset));
      expect(item.sourceText?.replace(/\s+/gu, ' ')).toBe(item.text);
    }
    expect(new Set(items.map((item) => item.spokenTextFingerprint)).size).toBe(items.length);
  });

  it('changes source and chunk identities when the source or pronunciation changes', () => {
    const source = paragraph('AI 본문.');
    const changed = paragraph('AI 변경 본문.');
    expect(plainTTSParagraphHash(source)).not.toBe(plainTTSParagraphHash(changed));
    expect(plainTTSParagraphHash({ ...source, textHash: 'different-metadata' })).toBe(plainTTSParagraphHash(source));
    const base = buildPlainTTSItems({ paragraph: source, rate: 1 });
    const spoken = buildPlainTTSItems({ paragraph: source, rules: [rule({})], rate: 1 });
    expect(base[0].spokenTextFingerprint).not.toBe(spoken[0].spokenTextFingerprint);
  });
});

describe('paragraph synthesis units', () => {
  it('combines sentences and punctuation without losing the source range', () => {
    const source = paragraph('... 첫 문장입니다. 다음 문장입니다!');
    const items = buildPlainTTSItems({ paragraph: source, rate: 1, chunking: 'paragraph' });
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe(source.text);
    expect(items[0].sourceRanges[0]).toMatchObject({ startOffset: 0, endOffset: source.text.length });
    expect(buildPlainTTSItems({ paragraph: source, rate: 1 }).length).toBeGreaterThan(1);
  });
  it('bounds oversized paragraphs without dropping Unicode characters', () => {
    const text = '가🙂'.repeat(800);
    const items = buildPlainTTSItems({ paragraph: paragraph(text), rate: 1, chunking: 'paragraph' });
    expect(items.map((item) => item.text).join('')).toBe(text);
    expect(items.every((item) => [...item.text].length <= 700)).toBe(true);
  });
});

describe('multi paragraph plain TTS', () => {
  it('batches short paragraphs with every source identity and leaves the next window untouched', async () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) =>
      paragraph('짧은 대사입니다.', { id: `p${index}`, index }),
    );
    const result = await preparePlainTTSBatch({
      index: 0,
      paragraph: paragraphs[0],
      paragraphCount: 20,
      getParagraph: async (i) => paragraphs[i],
      rate: 1,
      shouldContinue: () => true,
    });
    expect(result.nextParagraphIndex).toBe(16);
    expect(result.playables).toHaveLength(1);
    expect(result.playables[0].plainBatch).toHaveLength(16);
    expect(result.playables[0].sourceRanges.map((r) => r.paragraphId)).toEqual(
      paragraphs.slice(0, 16).map((p) => p.id),
    );
    const changed = paragraphs.slice(0, 16).map((p) => ({ ...p }));
    changed[3].text += '변경';
    expect(buildPlainTTSBatch({ paragraphs: changed, rate: 1 })?.spokenTextFingerprint).not.toBe(
      result.playables[0].spokenTextFingerprint,
    );
  });
  it('does not cross chapters, duplicate sources, oversize windows, or consume on cancellation', async () => {
    const a = paragraph('가'.repeat(400));
    const b = paragraph('나'.repeat(400), { id: 'b', index: 1 });
    expect(buildPlainTTSBatch({ paragraphs: [a, b], rate: 1 })).toBeUndefined();
    expect(buildPlainTTSBatch({ paragraphs: [a, a], rate: 1 })).toBeUndefined();
    expect(
      buildPlainTTSBatch({
        paragraphs: [paragraph('하나'), paragraph('둘', { id: 'b', index: 1, chapterId: 'other' })],
        rate: 1,
      }),
    ).toBeUndefined();
    const result = await preparePlainTTSBatch({
      index: 0,
      paragraph: a,
      paragraphCount: 2,
      getParagraph: async () => b,
      rate: 1,
      shouldContinue: () => false,
    });
    expect(result.nextParagraphIndex).toBe(1);
  });
});
