import { expect, it, vi } from 'vitest';
import { createTTSPositionWriter } from './tts-position-writer';
import { runTTSPlaybackSession } from './tts-playback-session-runner';
import { preparedNarrationSession } from './prepared-narration';
import type { PreparedNarration } from './plain-audiobook';
import type { Paragraph } from '../domain/types';

it('never holds prepared playback for a cursor write and coalesces pending writes in order', async () => {
  const writer = createTTSPositionWriter();
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const started: number[] = [];
  const finished: number[] = [];
  let active = 0;
  let peak = 0;
  const paragraph = {
    id: 'p',
    index: 1,
    novelId: 'b',
    chapterId: 'c',
    text: '이미 준비된 세 문장입니다.',
  } as Paragraph;
  const plan = {
    items: [0, 1, 2].map((ordinal) => ({
      paragraphIndex: 0,
      playable: {
        text: `준비 음성 ${ordinal}`,
        sourceRanges: [],
        sourceSegmentIds: [],
        rate: 1,
        preparedAudio: { id: 'saved', ordinal, ready: true },
      },
    })),
  } as unknown as PreparedNarration;
  const play = vi.fn(async () => true);
  try {
    const result = await runTTSPlaybackSession({
      ...preparedNarrationSession(plan, 0, async () => paragraph),
      shouldContinue: () => true,
      waitForResume: async () => true,
      buildPlayableSegments: () => [],
      buildSystemFallbackInput: () => ({ text: 'forbidden', rate: 1 }),
      speakSystem: vi.fn(),
      playHostedSegment: play,
      allowSystemFallback: false,
      onPlayableStart: (_index, playable) => {
        const ordinal = playable.preparedAudio!.ordinal;
        writer.enqueue(async () => {
          active++;
          peak = Math.max(peak, active);
          started.push(ordinal);
          try {
            if (ordinal === 0) {
              await held;
              throw Error('best effort cursor failure');
            }
            finished.push(ordinal);
          } finally {
            active--;
          }
        });
      },
    });
    expect(result.completed).toBe(true);
    expect(play).toHaveBeenCalledTimes(3);
    expect(started).toEqual([0]);
    release();
    await vi.waitFor(() => expect(started).toEqual([0, 2]));
    expect(finished).toEqual([2]);
    expect(peak).toBe(1);
    writer.close();
    const afterClose = vi.fn(async () => undefined);
    writer.enqueue(afterClose);
    expect(afterClose).not.toHaveBeenCalled();
  } finally {
    release();
    writer.close();
  }
});
