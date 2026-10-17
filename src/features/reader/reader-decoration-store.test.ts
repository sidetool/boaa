import { expect, it, vi } from 'vitest';
import { ReaderDecorationStore, type ReaderDecorationInput } from './reader-decoration-store';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';

const playback = (paragraphId: string, start = 0): ActiveTTSPlayback => ({
  paragraphId,
  ranges: [{ start, end: start + 3 }],
  speakerLabel: '',
  segmentIds: [],
});
function input(): ReaderDecorationInput {
  return {
    segments: [],
    characters: [],
    reviewSegmentIds: new Set(),
    highlights: [
      {
        id: 'h',
        novelId: 'book',
        chapterId: 'chapter',
        paragraphId: 'p1',
        quote: 'text',
        color: 'yellow',
        progress: 0,
        createdAt: 'now',
        updatedAt: 'now',
      },
    ],
  };
}
it('does not inspect static annotation objects during playback updates and only publishes old/new paragraphs', () => {
  const data = input();
  const quote = vi.fn(() => 'text');
  Object.defineProperty(data.highlights[0], 'quote', { get: quote });
  const store = new ReaderDecorationStore();
  store.update(data);
  quote.mockClear();
  const one = vi.fn(),
    two = vi.fn(),
    untouched = vi.fn();
  store.subscribe('p1', one);
  store.subscribe('p2', two);
  store.subscribe('p3', untouched);
  const highlighted = store.getSnapshot('p1');
  store.update({ ...data, activePlayback: playback('p1') });
  store.update({ ...data, activePlayback: playback('p1') });
  expect(one).toHaveBeenCalledTimes(1);
  store.update({ ...data, activePlayback: playback('p2') });
  expect(one).toHaveBeenCalledTimes(2);
  expect(two).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot('p1').highlights).toBe(highlighted.highlights);
  expect(store.getSnapshot('p1').activeRanges).toEqual([]);
  expect(untouched).not.toHaveBeenCalled();
  expect(quote).not.toHaveBeenCalled();
  store.update(data);
  expect(two).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot('p2').activeRanges).toEqual([]);
});
it('matches a full rebuild across annotation changes, playback-only paragraphs and playback clearing', () => {
  const store = new ReaderDecorationStore();
  const data = input();
  const changed = { ...data, highlights: [{ ...data.highlights[0], color: 'pink' as const }] };
  for (const next of [
    data,
    { ...data, activePlayback: playback('p1') },
    { ...data, activePlayback: playback('p2') },
    { ...data, activePlayback: playback('p2', 4) },
    { ...changed, activePlayback: playback('p2', 4) },
    changed,
    { ...changed, highlights: [] },
  ]) {
    store.update(next);
    const reference = new ReaderDecorationStore();
    reference.update(next);
    for (const id of ['p1', 'p2', 'p3']) expect(store.getSnapshot(id)).toEqual(reference.getSnapshot(id));
  }
});
it('keeps plugin layers through playback transitions and releases a removed layer', () => {
  const store = new ReaderDecorationStore();
  const data = input();
  store.update(data);
  store.plugins.replace(store.plugins.prepare('plugin', 0, [{ id: 'p2', text: 'text' }]), {
    layers: [
      {
        id: 'paint',
        palette: { ink: { color: '#123456' } },
        ranges: [{ paragraphId: 'p2', start: 0, end: 3, styleId: 'ink' }],
      },
    ],
  });
  const layers = store.getSnapshot('p2').pluginLayers;
  store.update({ ...data, activePlayback: playback('p2') });
  expect(store.getSnapshot('p2').pluginLayers).toBe(layers);
  store.update(data);
  expect(store.getSnapshot('p2').pluginLayers).toBe(layers);
  store.plugins.remove('plugin');
  expect(store.getSnapshot('p2').pluginLayers).toBeUndefined();
});
it('invalidates correction/review indexes independently of playback and preserves untouched snapshots', () => {
  const data: ReaderDecorationInput = {
    ...input(),
    segments: [
      {
        id: 'segment',
        novelId: 'book',
        chapterId: 'chapter',
        paragraphId: 'p1',
        segmentIndex: 0,
        startOffset: 0,
        endOffset: 4,
        segmentTextHash: 'hash',
        type: 'narration',
        speakerId: 'narrator',
        candidateSpeakers: [],
        listenerIds: [],
        emotion: 'neutral',
        confidence: 0.9,
        isUserCorrected: false,
      },
    ],
  };
  const store = new ReaderDecorationStore();
  store.update(data);
  const review = { ...data, reviewSegmentIds: new Set(['segment']), correctionTargetId: 'segment' };
  store.update(review);
  expect(store.getSnapshot('p1').correctionTargetId).toBe('segment');
  expect([...store.getSnapshot('p1').reviewSegmentIds]).toEqual(['segment']);
  const reviewed = store.getSnapshot('p1');
  store.update({ ...review, activePlayback: playback('p2') });
  expect(store.getSnapshot('p1')).toBe(reviewed);
  store.update({ ...review, activePlayback: playback('p1') });
  expect(store.getSnapshot('p1').segments).toBe(reviewed.segments);
  store.update({ ...data, activePlayback: playback('p1') });
  expect(store.getSnapshot('p1').correctionTargetId).toBeUndefined();
  expect(store.getSnapshot('p1').reviewSegmentIds.size).toBe(0);
  expect(store.getSnapshot('p1').activeRanges).toEqual(playback('p1').ranges);
});
