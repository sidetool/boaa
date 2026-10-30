import { estimatedPlainTTSParagraph } from './plain-tts-progress';
import { expect, it, vi } from 'vitest';
import type { Paragraph } from '../domain/types';
import type { PreparedNarration } from './plain-audiobook';
import { buildPlainTTSBatch, buildPlainTTSItems } from './plain-tts';
import { preparedNarrationJump, preparedNarrationSession } from './prepared-narration';
import { runTTSPlaybackSession } from './tts-playback-session-runner';
import { ttsQueueItemFingerprint } from './tts-playback-resume';
import { PlainTTSSessionCache } from './plain-tts-session-cache';

const paragraphs = ['첫 문단입니다.', '둘째 문단입니다.', '마지막 문단입니다.'].map(
  (text, index) => ({ id: `p${index}`, index: index + 1, chapterId: 'c', novelId: 'b', text }) as Paragraph,
);
const first = buildPlainTTSBatch({ paragraphs: paragraphs.slice(0, 2), rate: 1 })!;
const last = buildPlainTTSItems({ paragraph: paragraphs[2], rate: 1, chunking: 'sentence' })[0];
const plan: PreparedNarration = {
  id: 'recorded',
  chapterId: 'c',
  contentRevision: 'v1',
  voiceLabel: 'Recorded voice',
  items: [
    {
      ordinal: 0,
      paragraphIndex: 0,
      nextParagraphIndex: 2,
      playable: { ...first, preparedAudio: { id: 'recorded', ordinal: 0, ready: true } },
    },
    {
      ordinal: 1,
      paragraphIndex: 2,
      nextParagraphIndex: 3,
      playable: { ...last, preparedAudio: { id: 'recorded', ordinal: 1, ready: false } },
    },
  ],
};

it('buffers six saved clips during the first clip and keeps playing those clips while later downloads fail', async () => {
  const cache = new PlainTTSSessionCache();
  const sources = Array.from({ length: 9 }, (_, i) => ({ ...paragraphs[0], id: `p${i}`, index: i + 1 }));
  const saved: PreparedNarration = {
    ...plan,
    items: sources.map((paragraph, ordinal) => ({
      ordinal,
      paragraphIndex: ordinal,
      nextParagraphIndex: ordinal + 1,
      playable: {
        ...buildPlainTTSItems({ paragraph, rate: 1, chunking: 'sentence' })[0],
        preparedAudio: { id: 'recorded', ordinal, ready: true },
      },
    })),
  };
  let online = true;
  let cancelled = false;
  const downloads: number[] = [];
  const spoken: number[] = [];
  let finishFirst!: () => void;
  const firstPlaying = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const load = (ordinal: number) =>
    cache.getOrCreate({
      key: String(ordinal),
      scope: 'saved',
      chapter: 'c',
      positions: [ordinal],
      readOnly: true,
      fetch: async () => {
        if (!online) throw Error('background download delayed');
        downloads.push(ordinal);
        return new Blob([String(ordinal)]);
      },
    });
  const running = runTTSPlaybackSession({
    ...preparedNarrationSession(saved, 0, async (index) => sources[index]),
    shouldContinue: () => !cancelled,
    waitForResume: async () => true,
    buildPlayableSegments: () => [],
    allowSystemFallback: false,
    buildSystemFallbackInput: () => ({ text: 'unused', rate: 1 }),
    speakSystem: vi.fn(),
    hostedPrefetchDepth: () => 6,
    prefetchHostedSegment: async (playable) => {
      try {
        await load(playable.preparedAudio!.ordinal);
      } catch {
        /* speculative */
      }
    },
    playHostedSegment: async (playable) => {
      const ordinal = playable.preparedAudio!.ordinal;
      await load(ordinal);
      spoken.push(ordinal);
      if (ordinal === 0) await firstPlaying;
      return true;
    },
    shouldStopAfterItem: () => spoken.length === 7,
  });
  try {
    await vi.waitFor(() => expect(downloads).toEqual([0, 1, 2, 3, 4, 5, 6]));
    expect(spoken).toEqual([0]);
    online = false;
    finishFirst();
    await expect(running).resolves.toMatchObject({ stopReason: 'timer' });
    expect(spoken).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(downloads).toEqual([0, 1, 2, 3, 4, 5, 6]);
  } finally {
    cancelled = true;
    finishFirst();
    await running;
    cache.clear();
  }
});

it.each([
  { pending: 2, length: 10, expected: [1] },
  { pending: 1, length: 10, expected: [1] },
  { pending: 8, length: 700, expected: [1, 2] },
  { pending: 8, length: 1500, expected: [1] },
])('bounds saved read-ahead before pending synthesis and long batches: %j', async ({ pending, length, expected }) => {
  const items = Array.from({ length: 8 }, (_, ordinal) => ({
    ordinal,
    paragraphIndex: 0,
    nextParagraphIndex: 1,
    playable: {
      ...first,
      text: '가'.repeat(length),
      preparedAudio: { id: 'saved', ordinal, ready: ordinal !== pending },
    },
  }));
  let finish!: () => void;
  const held = new Promise<boolean>((resolve) => {
    finish = () => resolve(true);
  });
  const prefetched: number[] = [];
  const running = runTTSPlaybackSession({
    ...preparedNarrationSession({ ...plan, items }, 0, async () => paragraphs[0]),
    shouldContinue: () => true,
    waitForResume: async () => true,
    shouldStopAfterItem: () => true,
    buildPlayableSegments: () => [],
    allowSystemFallback: false,
    buildSystemFallbackInput: () => ({ text: 'unused', rate: 1 }),
    speakSystem: vi.fn(),
    playHostedSegment: () => held,
    hostedPrefetchDepth: () => 6,
    prefetchHostedSegment: async (playable) => {
      prefetched.push(playable.preparedAudio!.ordinal);
    },
  });
  try {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(prefetched).toEqual(expected);
  } finally {
    finish();
    await running;
  }
});

it('feeds the existing reader runner with recorded boundaries, source highlights, lookahead and completion', async () => {
  const active: string[] = [];
  const indices: number[] = [];
  const spoken: number[] = [];
  const prefetch = vi.fn();
  const nextChapter = vi.fn(async () => {});
  const rebuild = vi.fn(() => []);
  const session = preparedNarrationSession(plan, 1, async (i) => paragraphs[i]);
  expect(session.startIndex).toBe(0); // Resume inside a recorded batch starts that batch, not a new tail request.
  const result = await runTTSPlaybackSession({
    ...session,
    shouldContinue: () => true,
    waitForResume: async () => true,
    buildPlayableSegments: rebuild,
    allowSystemFallback: false,
    speakSystem: vi.fn(),
    buildSystemFallbackInput: () => ({ text: 'unused', rate: 1 }),
    playHostedSegment: async (playable) => {
      spoken.push(playable.preparedAudio!.ordinal);
      return true;
    },
    onParagraphStart: (i) => {
      indices.push(i);
    },
    onActivePlayback: (p) => {
      if (p) active.push(p.paragraphId);
    },
    prefetchHostedSegment: prefetch,
    prefetchNextChapter: nextChapter,
  });
  expect(result.completed).toBe(true);
  expect(indices).toEqual([0, 2]);
  expect(active).toEqual(['p0', 'p2']);
  expect(spoken).toEqual([0, 1]);
  expect(rebuild).not.toHaveBeenCalled();
  expect(prefetch).toHaveBeenCalledWith(plan.items[1].playable, paragraphs[2]);
  expect(nextChapter).toHaveBeenCalledOnce();
  expect(estimatedPlainTTSParagraph(first, 0.8)?.paragraphId).toBe('p1');
  expect(preparedNarrationJump(plan, 1, 1)).toBe(2);
  expect(preparedNarrationJump(plan, 1, -1)).toBe(0);
  expect(preparedNarrationJump(plan, 2, -1)).toBe(0);
  expect(preparedNarrationJump(plan, 2, 1)).toBeGreaterThan(2);
});

it('honors the normal queue cursor, timer and cancellation for prepared sentences in one paragraph', async () => {
  const paragraph = { ...paragraphs[0], text: '처음입니다. 다음입니다.' };
  const playables = buildPlainTTSItems({ paragraph, rate: 1, chunking: 'sentence' });
  expect(playables.length).toBe(2);
  const saved = {
    ...plan,
    items: playables.map((playable, ordinal) => ({ ordinal, paragraphIndex: 0, nextParagraphIndex: 1, playable })),
  };
  const play = vi.fn(async () => true);
  const result = await runTTSPlaybackSession({
    ...preparedNarrationSession(saved, 0, async () => paragraph),
    startQueueItemFingerprint: ttsQueueItemFingerprint(playables[1]),
    queueItemFingerprint: ttsQueueItemFingerprint,
    shouldContinue: () => true,
    waitForResume: async () => true,
    shouldStopAfterItem: () => true,
    buildPlayableSegments: () => [],
    playHostedSegment: play,
    allowSystemFallback: false,
    speakSystem: vi.fn(),
    buildSystemFallbackInput: () => ({ text: 'unused', rate: 1 }),
  });
  expect(play).toHaveBeenCalledExactlyOnceWith(playables[1], paragraph);
  expect(result.stopReason).toBe('timer');
  play.mockClear();
  await runTTSPlaybackSession({
    ...preparedNarrationSession(saved, 0, async () => paragraph),
    shouldContinue: () => false,
    waitForResume: async () => true,
    buildPlayableSegments: () => [],
    playHostedSegment: play,
    speakSystem: vi.fn(),
    buildSystemFallbackInput: () => ({ text: 'unused', rate: 1 }),
  });
  expect(play).not.toHaveBeenCalled();
});
