import { describe, expect, it } from 'vitest';
import { attributionStep, step } from './engine';
import { attribution, identity, source } from './test-fixtures';
import {
  SPEAKER_ENGINE_PROTOCOL,
  type SpeakerEngineResult,
  type SpeakerEngineSource,
} from '../../../src/providers/speaker-engine-protocol';

type Request = Extract<SpeakerEngineResult, { kind: 'request' }>;
const protocol = SPEAKER_ENGINE_PROTOCOL;
function prepared(s: SpeakerEngineSource) {
  const request = attributionStep({ protocol, source: s });
  expect(request.kind).toBe('request');
  const result = attributionStep({
    protocol,
    source: s,
    checkpoint: request.checkpoint,
    response: JSON.stringify(attribution(s)),
  });
  expect(result.kind).toBe('attributed');
  return result.checkpoint;
}

describe('source-only attribution preparation', () => {
  it('reuses A across ledger changes and builds B from the actual preceding chapter ledger', () => {
    const next = { ...source, chapter: { ...source.chapter, id: 'c2', index: 2 } };
    const nextA = prepared(next);
    const firstB = step({ protocol, source, attribution: prepared(source) }) as Request;
    expect(firstB.stage).toBe('identity');
    const first = step({ protocol, source, checkpoint: firstB.checkpoint, response: JSON.stringify(identity(firstB)) });
    if (first.kind !== 'complete') throw Error('expected first result');
    expect(() => step({ protocol, source: next, attribution: nextA })).toThrow(
      'speaker_lab_sequential_identity_block_scope_invalid',
    );
    const before = step({
      protocol,
      source: next,
      attribution: nextA,
      ledger: { ...(first.ledger as object), fixtureRevision: 'alternate' },
    }) as Request;
    const after = step({ protocol, source: next, attribution: nextA, ledger: first.ledger }) as Request;
    expect(after.stage).toBe('identity');
    expect(after.checkpoint).not.toEqual(before.checkpoint);
    const packet = JSON.parse(after.prompt.split('\nSOURCE_JSON=')[1]);
    expect(packet.activated_prior_identities).toEqual(
      expect.arrayContaining([expect.objectContaining({ work_speaker_id: first.identities[0].id })]),
    );
    const second = step({
      protocol,
      source: next,
      ledger: first.ledger,
      checkpoint: after.checkpoint,
      response: JSON.stringify(identity(after, first.identities[0].id)),
    });
    expect(second.kind === 'complete' && second.identities.map((i) => i.id)).toEqual([first.identities[0].id]);
    expect(() => step({ protocol, source: next, ledger: first.ledger, checkpoint: before.checkpoint })).toThrow(
      'checkpoint_scope_changed',
    );
  });

  it('validates prepared A model replies and rejects source changes without leaking into B', () => {
    const request = attributionStep({ protocol, source });
    const wire = attribution(source);
    expect(() =>
      attributionStep({
        protocol,
        source,
        checkpoint: request.checkpoint,
        response: JSON.stringify({ ...wire, labels: [] }),
      }),
    ).toThrow();
    const done = prepared(source);
    for (const changed of [
      { ...source, revision: 'changed' },
      {
        ...source,
        chapter: { ...source.chapter, paragraphs: [{ id: 'p1', index: 1, text: '다른 인물이 말했다. “다른 말.”' }] },
      },
    ]) {
      expect(() => attributionStep({ protocol, source: changed, checkpoint: done })).toThrow(
        'attribution_scope_changed',
      );
      expect(() => step({ protocol, source: changed, attribution: done })).toThrow('attribution_scope_changed');
    }
  });

  it('continues a legacy partial A checkpoint even when a separately prepared A is supplied', () => {
    const legacy = step({ protocol, source }) as Request;
    const next = step({ protocol, source, checkpoint: legacy.checkpoint, attribution: prepared(source) }) as Request;
    expect(next.stage).toBe('attribution');
    expect(next.prompt).toBe(legacy.prompt);
    const b = step({
      protocol,
      source,
      checkpoint: next.checkpoint,
      response: JSON.stringify(attribution(source)),
    }) as Request;
    expect(b.stage).toBe('identity');
  });
});
