import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { ReaderDecorationStore, type ReaderDecorationInput } from './reader-decoration-store';

it('measures transient playback with 15,000 annotated paragraphs', () => {
  const store = new ReaderDecorationStore();
  const input: ReaderDecorationInput = {
    segments: [],
    characters: [],
    reviewSegmentIds: new Set(),
    highlights: Array.from({ length: 15000 }, (_, i) => ({
      id: `h-${i}`,
      novelId: 'synthetic-book',
      chapterId: 'synthetic-chapter',
      paragraphId: `p-${i}`,
      quote: 'Synthetic text',
      color: 'yellow',
      progress: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    })),
  };
  store.update(input);
  let notifications = 0;
  for (let i = 0; i < 15000; i++) store.subscribe(`p-${i}`, () => notifications++);
  const samples: number[] = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    store.update({
      ...input,
      activePlayback: { paragraphId: `p-${i}`, ranges: [{ start: 0, end: 5 }], speakerLabel: '', segmentIds: [] },
    });
    const elapsed = performance.now() - start;
    if (i >= 10) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  expect(notifications).toBe(79);
  process.stdout.write(
    JSON.stringify({
      scenario: '15k-annotation-playback',
      warmup: 10,
      samples: samples.length,
      medianMs: samples[15],
      p95Ms: samples[28],
      notifications,
    }) + '\n',
  );
});
