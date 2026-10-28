import {
  PERFORMANCE_SCHEMA,
  PERFORMANCE_INSTRUCTION,
  parsePerformance,
  type SpeakerPerformance,
} from '../../../src/providers/tts-performance';
import * as a from './preset35/chapter-context-speaker';
export type PerformanceOutput = a.SpeakerChapterLabelV1 & { performance?: Record<string, SpeakerPerformance> };
export function performanceRequest(
  prepared: a.PreparedChapterSpeakerRun,
  unit: a.ChapterSpeakerUnit,
  enabled: boolean,
) {
  const r = a.buildChapterSpeakerRequest({ prepared, unit });
  if (!enabled) return r;
  const schema = r.responseSchema as { required: string[]; properties: Record<string, unknown> };
  return {
    ...r,
    prompt:
      r.prompt +
      '\nAdditionally return performance for every requested target_id, using target_id as id.\n' +
      PERFORMANCE_INSTRUCTION,
    responseSchema: {
      ...schema,
      required: [...schema.required, 'performance'],
      properties: {
        ...schema.properties,
        performance: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'acting'],
            properties: { id: { type: 'string' }, acting: PERFORMANCE_SCHEMA },
          },
        },
      },
    },
  };
}
export function performanceOutput(
  prepared: a.PreparedChapterSpeakerRun,
  unit: a.ChapterSpeakerUnit,
  raw: string,
  enabled: boolean,
): PerformanceOutput {
  const value = JSON.parse(raw);
  const base = enabled && value && typeof value === 'object' ? { ...value } : value;
  if (enabled && base) delete base.performance;
  const output = a.validateChapterSpeakerWire({ prepared, unit, wire: a.parseChapterSpeakerWire(base) });
  if (!enabled) return output;
  if (!Array.isArray(value.performance) || value.performance.length !== unit.requestedTargetIds.length)
    throw new Error('missing_speaker_performance');
  const entries = new Map<string, SpeakerPerformance>();
  for (const row of value.performance) {
    if (!row || !unit.requestedTargetIds.includes(row.id) || entries.has(row.id) || Object.keys(row).length !== 2)
      throw new Error('invalid_performance_target');
    entries.set(row.id, parsePerformance(row.acting));
  }
  return { ...output, performance: Object.fromEntries(entries) };
}
