import { describe, expect, it } from 'vitest';
import type { Paragraph } from '@boaa/contracts';
import { NEUTRAL_PERFORMANCE } from '../../../../src/providers/tts-performance';
import { preparedNarrationQueue } from '../../../../src/providers/prepared-narration';
import type { AudiobookPlan } from './audiobook-plan';
import { batchCastRequests } from './speaker-audio-batching';
import { castPlayable, castRequests, unbatchCastRequest } from './speaker-generation-plan';

const model = { providerId: 'fixture', modelId: 'gemini-3.8-flash-tts', revision: 'one' };
const settings = {
  voiceId: 'n',
  rules: [],
  modelRevision: 'one',
  cast: { language: 'ko', models: { n: model }, autoActing: true },
} as unknown as AudiobookPlan['settings'];
const paragraphs = (texts: string[]) =>
  texts.map((text, i) => ({
    id: `p${i}`,
    novelId: 'book',
    chapterId: 'chapter',
    index: i + 1,
    text,
  })) as Paragraph[];
const requestsFor = (ps: Paragraph[]) => castRequests(ps, [], [], {}, settings);

describe('Gemini contiguous cast audio batching', () => {
  it('sends one text for adjacent identical voices while retaining source anchors and paragraph navigation', () => {
    const ps = paragraphs(['문이 열렸다.', '달빛 🌙 아래로 걸었다.', '잠시 멈췄다.']);
    const original = requestsFor(ps);
    const grouped = batchCastRequests(ps, original, [], true, true);
    expect(grouped).toHaveLength(1);
    expect(batchCastRequests(ps, original, [], true)).toEqual(original);
    expect(batchCastRequests(ps, grouped, [], true, false)).toEqual(original);
    expect(unbatchCastRequest(grouped[0])).toEqual(original);
    expect(original.every((r) => !r.cast.batch)).toBe(true);
    const playable = castPlayable(ps, grouped[0], []);
    expect(playable.text).toBe(ps.map((p) => p.text).join('\n\n'));
    expect(playable.sourceRanges.map((r) => r.paragraphId)).toEqual(['p0', 'p1', 'p2']);
    expect(playable.plainBatchPositions?.map((p) => p.paragraphIndex)).toEqual([0, 1, 2]);
    const plan = {
      id: 'job',
      chapterId: 'chapter',
      voiceLabel: 'fixture',
      items: [{ ordinal: 0, paragraphIndex: 0, nextParagraphIndex: 3, playable }],
    };
    expect(preparedNarrationQueue(plan, 2).startIndex).toBe(0);
    expect(() =>
      castPlayable(
        ps.map((p, i) => (i === 1 ? { ...p, text: '변경됨' } : p)),
        grouped[0],
        [],
      ),
    ).toThrow();
  });

  it('keeps character, voice, model, manual directions and scene acting boundaries', () => {
    const ps = paragraphs(Array(7).fill('잠시 멈췄다.'));
    const requests = requestsFor(ps);
    requests[1].cast.speakerId = 'other';
    requests[2].voiceId = 'other';
    requests[3].cast.model = { ...model, revision: 'changed' };
    requests[4].cast.instructions = '낮게 속삭이기';
    requests[5].cast.performance = { ...NEUTRAL_PERFORMANCE, delivery: 'shouting' };
    expect(batchCastRequests(ps, requests, [], true, true)).toHaveLength(7);
    requests[5].cast.performance = NEUTRAL_PERFORMANCE;
    expect(batchCastRequests(ps, requests, [], true, true)).toHaveLength(6);
  });

  it('bounds text and source count, and never merges unanalyzed acting or other TTS providers', () => {
    const ps = paragraphs(Array(18).fill('짧은 문장.'));
    const original = requestsFor(ps);
    expect(batchCastRequests(ps, original, [], true, true).map((r) => unbatchCastRequest(r).length)).toEqual([16, 2]);
    const long = paragraphs(Array(4).fill('가'.repeat(240)));
    expect(batchCastRequests(long, requestsFor(long), [], true, true)).toHaveLength(2);
    for (const r of original) delete r.cast.performance;
    expect(batchCastRequests(ps, original, [], true, true)).toHaveLength(18);
    expect(batchCastRequests(ps, original, [], false, true)).toHaveLength(2);
    for (const r of original) r.cast.model = { ...model, modelId: 'other' };
    expect(batchCastRequests(ps, original, [], false, true)).toHaveLength(18);
  });

  it('does not reorder chapter/footnote ranges or overlap anchors in one paragraph', () => {
    const ps = paragraphs(['첫 문장.', '두 번째 문장.']);
    const requests = requestsFor(ps);
    expect(batchCastRequests(ps, [...requests].reverse(), [], true, true)).toHaveLength(2);
    expect(batchCastRequests(ps, [requests[0], requests[0]], [], true, true)).toHaveLength(2);
    ps[1].chapterId = 'next';
    expect(batchCastRequests(ps, requests, [], true, true)).toHaveLength(2);
  });
});
