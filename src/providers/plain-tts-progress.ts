import type { PlayableTtsSegment } from './tts-playback';

/** Proportional paragraph following only: the provider supplies no word timestamps. */
export function estimatedPlainTTSParagraph(playable: PlayableTtsSegment, fraction: number) {
  const positions = playable.plainBatchPositions;
  if (!positions?.length || !Number.isFinite(fraction)) return;
  const total = positions.reduce((sum, position) => sum + Math.max(1, position.spokenLength), 0);
  const offset = Math.max(0, Math.min(1, fraction)) * total;
  let end = 0;
  for (const position of positions) {
    end += Math.max(1, position.spokenLength);
    if (offset < end) return position;
  }
  return positions[positions.length - 1];
}
