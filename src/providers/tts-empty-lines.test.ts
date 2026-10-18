import { afterEach, expect, it, vi } from 'vitest';
import type { Paragraph } from '../domain/types';
import { buildPlainTTSItems, preparePlainTTSBatch } from './plain-tts';
import { runTTSPlaybackSession } from './tts-playback-session-runner';
import { hasSpokenContent } from './tts-spoken-content';
const paragraphs: Paragraph[] = ['첫 문단입니다.', '\n\t\u00a0', '\u200b\u2060', '다음 문단입니다.'].map((text, i) => ({
  id: `p${i}`,
  novelId: 'b',
  chapterId: 'c',
  index: i + 1,
  text,
  textHash: `h${i}`,
  startOffsetInChapter: 0,
  endOffsetInChapter: text.length,
}));
afterEach(() => vi.useRealTimers());
it('skips blank and invisible formatting lines without extra synthesis, highlight, or pauses', async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const played: string[] = [];
  const result = runTTSPlaybackSession({
    startIndex: 0,
    paragraphCount: 4,
    getParagraph: async (i) => paragraphs[i],
    buildPlayableSegments: (paragraph) => buildPlainTTSItems({ paragraph, rate: 1, chunking: 'paragraph' }),
    shouldContinue: () => true,
    waitForResume: async () => true,
    allowSystemFallback: false,
    playHostedSegment: async (p) => {
      played.push(p.paragraphId);
      return true;
    },
    onParagraphStart: (i) => {
      starts.push(i);
    },
    paragraphPauseMs: 420,
    buildSystemFallbackInput: (p) => ({ text: p.text, rate: 1 }),
    speakSystem: async () => {
      throw Error('no system fallback');
    },
  });
  await vi.advanceTimersByTimeAsync(420);
  expect((await result).completed).toBe(true);
  expect(starts).toEqual([0, 3]);
  expect(played).toEqual(['p0', 'p3']);
  expect(hasSpokenContent('...')).toBe(true);
});
it('groups across blank lines while preserving real source ordinals and the next playback cursor', async () => {
  const result = await preparePlainTTSBatch({
    index: 0,
    paragraph: paragraphs[0],
    paragraphCount: 4,
    getParagraph: async (i) => paragraphs[i],
    rate: 1,
    shouldContinue: () => true,
  });
  expect(result.nextParagraphIndex).toBe(4);
  expect(result.playables).toHaveLength(1);
  expect(result.playables[0].plainBatch?.map((p) => p.paragraphId)).toEqual(['p0', 'p3']);
  expect(result.playables[0].plainBatchPositions?.map((p) => p.paragraphIndex)).toEqual([0, 3]);
  expect(result.playables[0].text).not.toContain('\u200b');
});
