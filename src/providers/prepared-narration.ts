import type { PreparedNarration } from './plain-audiobook';
import type { Paragraph } from '../domain/types';

/** Feed recorded source ranges to the existing paragraph/highlight/sleep/chapter runner. */
export function preparedNarrationQueue(plan: PreparedNarration, requestedIndex: number) {
  const groups: { paragraphIndex: number; playables: PreparedNarration['items'][number]['playable'][] }[] = [];
  for (const item of plan.items) {
    if (item.playable.preparedAudio?.skipped) continue;
    const last = groups[groups.length - 1];
    if (last?.paragraphIndex === item.paragraphIndex) last.playables.push(item.playable);
    else groups.push({ paragraphIndex: item.paragraphIndex, playables: [item.playable] });
  }
  const contains = groups.findIndex(
    (group) =>
      group.paragraphIndex === requestedIndex ||
      group.playables.some((item) => item.plainBatchPositions?.some((p) => p.paragraphIndex === requestedIndex)),
  );
  const after = groups.findIndex((group) => group.paragraphIndex >= requestedIndex);
  return { groups, startIndex: contains >= 0 ? contains : after >= 0 ? after : groups.length };
}

/** Skip whole recorded groups, even when the user's current chunk-size setting has changed. */
export function preparedNarrationJump(plan: PreparedNarration, index: number, direction: -1 | 1): number {
  const { groups, startIndex } = preparedNarrationQueue(plan, index);
  const current = groups[startIndex];
  if (direction < 0 && current && index > current.paragraphIndex) return current.paragraphIndex;
  return groups[Math.max(0, startIndex + direction)]?.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
}

export function preparedNarrationSession(
  plan: PreparedNarration,
  requestedIndex: number,
  getSourceParagraph: (index: number) => Promise<Paragraph | undefined>,
) {
  const queue = preparedNarrationQueue(plan, requestedIndex);
  return {
    startIndex: queue.startIndex,
    paragraphCount: queue.groups.length,
    getParagraph: (index: number) => getSourceParagraph(queue.groups[index].paragraphIndex),
    sourceParagraphIndex: (_paragraph: Paragraph, index: number) => queue.groups[index].paragraphIndex,
    prepareParagraph: async (index: number) => ({
      playables: queue.groups[index].playables,
      nextParagraphIndex: index + 1,
    }),
  };
}
