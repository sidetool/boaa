import { describe, expect, it } from 'vitest';
import type { Paragraph, SpokenTextRule } from '../domain/types';
import { buildPlainTTSItems, plainTTSParagraphHash } from './plain-tts';

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
