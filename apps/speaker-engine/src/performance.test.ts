import { describe, expect, it } from 'vitest';
import { attributionStep, ENGINE_VERSION, prepare, step } from './engine';
import { attribution, identity, source } from './test-fixtures';
import {
  SPEAKER_ENGINE_PROTOCOL as protocol,
  type SpeakerEngineResult,
  type SpeakerEngineSource,
} from '../../../src/providers/speaker-engine-protocol';
import {
  NEUTRAL_PERFORMANCE,
  PERFORMANCE_SCHEMA,
  type SpeakerPerformance,
} from '../../../src/providers/tts-performance';
type Request = Extract<SpeakerEngineResult, { kind: 'request' }>;
const acting: SpeakerPerformance = { emotion: 'sad', delivery: 'whispering', pace: 'slow', intensity: 'subtle' };
function wire(s: SpeakerEngineSource) {
  return { ...attribution(s), performance: prepare(s).input.targets.map((t) => ({ id: t.targetId, acting })) };
}

describe('automatic acting A annotations', () => {
  it('maps validated target tags onto the same UTF-16 spans, speaker identities and cache fingerprints', () => {
    const legacy = step({ protocol, source }) as Request;
    const tagged = step({ protocol, source, autoActing: true }) as Request;
    expect(ENGINE_VERSION).toBe('preset35-boaa-2');
    expect((tagged.checkpoint as { fingerprint: string }).fingerprint).toBe(
      (legacy.checkpoint as { fingerprint: string }).fingerprint,
    );
    expect(tagged.schema).toMatchObject({
      required: expect.arrayContaining(['performance']),
      properties: { performance: { items: { properties: { acting: PERFORMANCE_SCHEMA } } } },
    });
    const legacyB = step({
      protocol,
      source,
      checkpoint: legacy.checkpoint,
      response: JSON.stringify(attribution(source)),
    }) as Request;
    const b = step({
      protocol,
      source,
      checkpoint: tagged.checkpoint,
      response: JSON.stringify(wire(source)),
    }) as Request;
    expect(b.stage).toBe('identity');
    const done = step({ protocol, source, checkpoint: b.checkpoint, response: JSON.stringify(identity(b)) });
    const oldDone = step({
      protocol,
      source,
      checkpoint: legacyB.checkpoint,
      response: JSON.stringify(identity(legacyB)),
    });
    if (done.kind !== 'complete' || oldDone.kind !== 'complete') throw Error('expected completed B');
    expect(done.identities).toEqual(oldDone.identities);
    expect(done.labels.map(({ performance: _performance, ...label }) => label)).toEqual(oldDone.labels);
    expect(done.labels.map((label) => label.performance)).toEqual(done.labels.map(() => acting));
    expect(
      done.labels.map((label) =>
        source.chapter.paragraphs
          .find((p) => p.id === label.paragraphId)!
          .text.slice(label.startOffset, label.endOffset),
      ),
    ).toEqual(
      oldDone.labels.map((label) =>
        source.chapter.paragraphs
          .find((p) => p.id === label.paragraphId)!
          .text.slice(label.startOffset, label.endOffset),
      ),
    );
  });

  it('rejects missing, foreign, duplicate, extra and invalid tags before B while stripping only the allowed extension', () => {
    const s = {
      ...source,
      chapter: { ...source.chapter, paragraphs: [{ id: 'p1', index: 1, text: '민아가 말했다. “첫 말.” “다음 말.”' }] },
    };
    const a = attributionStep({ protocol, source: s, autoActing: true });
    const response = wire(s);
    expect(response.performance.length).toBeGreaterThan(1);
    const bad = [
      undefined,
      [],
      response.performance.map((row, i) => (i ? row : { ...row, id: 'foreign' })),
      response.performance.map((row, i) => (i ? row : { ...row, id: response.performance[1].id })),
      response.performance.map((row) => ({ ...row, acting: { ...acting, emotion: 'invented' } })),
      response.performance.map((row) => ({ ...row, acting: { ...acting, accent: 'invented' } })),
      response.performance.map((row) => ({ ...row, voice: 'forbidden' })),
    ];
    for (const performance of bad)
      expect(() =>
        attributionStep({
          protocol,
          source: s,
          checkpoint: a.checkpoint,
          response: JSON.stringify({ ...response, performance }),
        }),
      ).toThrow();
    expect(() =>
      attributionStep({
        protocol,
        source: s,
        checkpoint: a.checkpoint,
        response: JSON.stringify({ ...response, extraBaseField: 'not allowed' }),
      }),
    ).toThrow();
    expect(
      attributionStep({ protocol, source: s, checkpoint: a.checkpoint, response: JSON.stringify(response) }).kind,
    ).toBe('attributed');
  });

  it('retains legacy partial checkpoints when enabled later without replaying accepted A', () => {
    const legacy = attributionStep({ protocol, source });
    const enabled = attributionStep({ protocol, source, checkpoint: legacy.checkpoint, autoActing: true });
    expect(enabled).toEqual(legacy);
    const completed = attributionStep({
      protocol,
      source,
      checkpoint: enabled.checkpoint,
      autoActing: true,
      response: JSON.stringify(attribution(source)),
    });
    expect(completed.kind).toBe('attributed');
    const b = step({ protocol, source, attribution: completed.checkpoint, autoActing: true }) as Request;
    expect(b.stage).toBe('identity');
    const done = step({ protocol, source, checkpoint: b.checkpoint, response: JSON.stringify(identity(b)) });
    expect(done.kind === 'complete' && done.labels.every((label) => label.performance === undefined)).toBe(true);
  });

  it('preserves every tag across chunked A and leaves sequential B as a single ordered request', () => {
    const s = {
      ...source,
      chapter: {
        ...source.chapter,
        paragraphs: Array.from({ length: 121 }, (_, i) => ({
          id: 'p' + i,
          index: i + 1,
          text: '민아가 말했다. “안녕 🌙.”',
        })),
      },
    };
    const prepared = prepare(s);
    let result = attributionStep({ protocol, source: s, autoActing: true });
    for (const unit of prepared.fallbackUnits) {
      expect(result.kind).toBe('request');
      const whole = wire(s);
      result = attributionStep({
        protocol,
        source: s,
        checkpoint: result.checkpoint,
        response: JSON.stringify({
          ...whole,
          labels: whole.labels.filter((label) => unit.requestedTargetIds.includes(label.target_id)),
          performance: whole.performance.filter((row) => unit.requestedTargetIds.includes(row.id)),
        }),
      });
    }
    expect(result.kind).toBe('attributed');
    const b = step({ protocol, source: s, attribution: result.checkpoint }) as Request;
    expect(b.stage).toBe('identity');
    const bWire = identity(b);
    bWire.groups[0].member_local_speaker_ids = [...new Set(bWire.groups[0].member_local_speaker_ids)];
    const done = step({ protocol, source: s, checkpoint: b.checkpoint, response: JSON.stringify(bWire) });
    if (done.kind !== 'complete') throw Error('expected complete');
    expect(done.labels).toHaveLength(121);
    expect(done.labels.every((label) => label.performance?.emotion === 'sad')).toBe(true);
    expect(NEUTRAL_PERFORMANCE.emotion).toBe('neutral');
  });
});
