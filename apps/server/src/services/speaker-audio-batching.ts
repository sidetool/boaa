import type { Paragraph, SpokenTextRule } from '@boaa/contracts';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import { isGeminiActingModel } from '../../../../src/providers/tts-performance';
import { castPlayable, unbatchCastRequest, type CastRequest, type CastSource } from './speaker-generation-plan';

/** Batch only adjacent, identical character voices and acting. Source anchors remain individually verifiable. */
export function batchCastRequests(
  paragraphs: readonly Paragraph[],
  requests: readonly CastRequest[],
  rules: readonly SpokenTextRule[],
  autoActing = false,
  enabled = false,
): CastRequest[] {
  if (!enabled) return requests.flatMap(unbatchCastRequest);
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const result: CastRequest[] = [];
  let previous: { key: string; length: number; paragraph: Paragraph; end: number; count: number } | undefined;
  for (const request of requests.flatMap(unbatchCastRequest)) {
    const p = byId.get(request.paragraphId);
    if (!p) throw new Error('Missing cast source paragraph');
    const playable = castPlayable(p, request, rules);
    const key = structuredIntegrityHash({
      voiceId: request.voiceId,
      rate: request.rate,
      modelRevision: request.modelRevision,
      voiceRevision: request.voiceRevision,
      contentRevision: request.contentRevision,
      speakerId: request.cast.speakerId,
      model: request.cast.model,
      language: request.cast.language,
      instructions: request.cast.instructions,
      performance: request.cast.performance,
    });
    const eligible =
      (isGeminiActingModel(request.cast.model.modelId) || !!request.cast.model.performanceFormat) &&
      (!autoActing || !!request.cast.performance);
    const length = [...playable.text].length;
    const separator = previous?.paragraph.id === p.id ? 1 : 2;
    if (
      eligible &&
      previous?.key === key &&
      previous.count < 16 &&
      previous.paragraph.chapterId === p.chapterId &&
      p.index >= previous.paragraph.index &&
      (p.id !== previous.paragraph.id || playable.sourceRanges[0].startOffset >= previous.end) &&
      previous.length + separator + length <= 700
    ) {
      const source: CastSource = {
        paragraphId: request.paragraphId,
        paragraphHash: request.paragraphHash,
        chunkHash: request.chunkHash,
        start: request.cast.start,
        end: request.cast.end,
        part: request.cast.part,
      };
      const last = result[result.length - 1];
      last.cast.batch = [...(last.cast.batch ?? []), source];
      previous = {
        key,
        length: previous.length + separator + length,
        paragraph: p,
        end: playable.sourceRanges.at(-1)!.endOffset,
        count: previous.count + 1,
      };
    } else {
      result.push({ ...request, cast: { ...request.cast } });
      previous = eligible
        ? { key, length, paragraph: p, end: playable.sourceRanges.at(-1)!.endOffset, count: 1 }
        : undefined;
    }
  }
  return result;
}
