import { describe, expect, it } from 'vitest';
import { textIntegrityHash } from '@boaa/text-core/hash';
import type { Paragraph } from '@boaa/contracts';
import type { AudiobookPlan } from './audiobook-plan';
import { castPlayable, castRequests } from './speaker-generation-plan';
import { buildPlainTTSItems } from '../../../../src/providers/plain-tts';

const paragraph = {
  id: 'p',
  novelId: 'book',
  chapterId: 'chapter',
  index: 1,
  text: '민아가 말했다. “안녕 🌙.” 잠시 쉬었다.',
} as Paragraph;
const start = paragraph.text.indexOf('“');
const end = paragraph.text.indexOf('”') + 1;
const label = {
  paragraphId: paragraph.id,
  startOffset: start,
  endOffset: end,
  textHash: textIntegrityHash(paragraph.text.slice(start, end)),
  speakerId: 'mina',
  reviewRequired: false,
};
const settings: AudiobookPlan['settings'] = {
  chapterIds: ['chapter'],
  voiceId: 'n',
  modelRevision: 'fixture',
  chunking: 'paragraph',
  footnotePlayback: 'skip',
  rules: [],
  cast: {
    engineId: 'fixture',
    engineRevision: 'fixture',
    engineVersion: 'fixture',
    characterVoiceIds: ['a'],
    models: {
      n: { providerId: 'fixture', modelId: 'fixture', revision: 'fixture' },
      a: { providerId: 'fixture', modelId: 'fixture', revision: 'fixture' },
    },
  },
};
const identities = [{ id: 'mina', name: '민아', reviewRequired: false }];

describe('speaker source reconstruction', () => {
  it('keeps UTF-16 source positions and narration on both sides of an emoji dialogue', () => {
    const requests = castRequests([paragraph], [label], identities, { mina: 'a' }, settings);
    expect(requests.map((r) => r.voiceId)).toEqual(['n', 'a', 'n']);
    const playables = requests.map((r) => castPlayable(paragraph, r, []));
    expect(playables[1].sourceRanges).toEqual([
      { segmentId: '', paragraphId: 'p', startOffset: start, endOffset: end },
    ]);
    expect(playables[1].text).toBe('“안녕 🌙.”');
    for (const p of playables) {
      expect(
        p.sourceRanges
          .map((r) => paragraph.text.slice(r.startOffset, r.endOffset))
          .join('')
          .trim(),
      ).toBe(p.text);
    }
    expect(
      playables
        .map((p) => p.text)
        .join('')
        .replace(/\s/gu, ''),
    ).toBe(paragraph.text.replace(/\s/gu, ''));
  });

  it('reads unknown and review-required dialogue with the narrator without dropping source text', () => {
    for (const uncertain of [
      { ...label, speakerId: 'unknown' },
      { ...label, reviewRequired: true },
    ]) {
      const requests = castRequests([paragraph], [uncertain], identities, { mina: 'a' }, settings);
      expect(requests.map((r) => r.voiceId)).toEqual(['n', 'n', 'n']);
      expect(
        requests
          .map((r) => castPlayable(paragraph, r, []).text)
          .join('')
          .replace(/\s/gu, ''),
      ).toBe(paragraph.text.replace(/\s/gu, ''));
    }
  });

  it('rejects foreign, overlapping, out-of-bounds and hash-mismatched labels and changed saved source', () => {
    for (const labels of [
      [{ ...label, paragraphId: 'foreign' }],
      [label, label],
      [{ ...label, startOffset: -1 }],
      [{ ...label, endOffset: paragraph.text.length + 1 }],
      [{ ...label, textHash: textIntegrityHash('changed') }],
    ])
      expect(() => castRequests([paragraph], labels, identities, { mina: 'a' }, settings)).toThrow();
    const request = castRequests([paragraph], [label], identities, { mina: 'a' }, settings)[1];
    expect(() => castPlayable({ ...paragraph, text: paragraph.text + 'changed' }, request, [])).toThrow();
    expect(() => castPlayable(paragraph, { ...request, chunkHash: 'changed' }, [])).toThrow();
  });

  it('rebases EPUB ruby and footnote semantics within a sliced dialogue back to original source ranges', () => {
    const text = '서문. “東京※.” 끝.';
    const rubyStart = text.indexOf('東京');
    const markerStart = text.indexOf('※');
    const epub: Paragraph = {
      ...paragraph,
      text,
      inlineSemantics: [
        { kind: 'ruby', start: rubyStart, end: rubyStart + 2, value: 'とうきょう' },
        { kind: 'footnote_reference', start: markerStart, end: markerStart + 1, value: '#note' },
      ],
    };
    const dialogue = { ...label, startOffset: text.indexOf('“'), endOffset: text.indexOf('”') + 1 };
    dialogue.textHash = textIntegrityHash(text.slice(dialogue.startOffset, dialogue.endOffset));
    const request = castRequests([epub], [dialogue], identities, { mina: 'a' }, settings)[1];
    const playable = castPlayable(epub, request, []);
    expect(playable.text).toBe('“とうきょう.”');
    expect(playable.sourceRanges[0]).toMatchObject({
      startOffset: dialogue.startOffset,
      endOffset: dialogue.endOffset,
    });
    expect(playable.sourceText).toBe(text.slice(dialogue.startOffset, dialogue.endOffset));
    expect(() => castPlayable({ ...epub, inlineSemantics: [] }, request, [])).toThrow();
  });
  it('pins English date and symbol normalization through the same plain TTS roundtrip', () => {
    const source: Paragraph = { ...paragraph, text: '2026-08-01 & 25%' };
    const english = { ...settings, cast: { ...settings.cast!, language: 'en-US' } };
    const expected = buildPlainTTSItems({
      paragraph: source,
      language: 'en-US',
      chunking: 'batch',
      batchCharacters: 700,
      rate: 1,
      rules: [],
    });
    const requests = castRequests([source], [], [], {}, english);
    expect(requests.every((r) => r.cast.language === 'en-US')).toBe(true);
    const playables = requests.map((r) => castPlayable(source, r, []));
    expect(playables.map((p) => p.text)).toEqual(expected.map((p) => p.text));
    expect(playables.map((p) => p.text)).toEqual(['August 1, 2026 and 25 percent']);
    expect(playables.map((p) => p.sourceRanges)).toEqual(expected.map((p) => p.sourceRanges));
    expect(() =>
      castPlayable(source, { ...requests[0], cast: { ...requests[0].cast, language: 'ko-KR' } }, []),
    ).toThrow();
  });
});
