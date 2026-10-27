import { describe, expect, it } from 'vitest';
import { prepare, step } from './engine';
import { SPEAKER_ENGINE_PROTOCOL, type SpeakerEngineResult } from '../../../src/providers/speaker-engine-protocol';

type Request = Extract<SpeakerEngineResult, { kind: 'request' }>;
import { source, attribution, identity } from './test-fixtures';
function begin(s = source, ledger?: unknown) {
  return step({ protocol: SPEAKER_ENGINE_PROTOCOL, source: s, ledger }) as Request;
}
describe('real preset35 adapter', () => {
  it('runs A then B, keeps source UTF-16 spans and links the same speaker in the next chapter', () => {
    const a = begin();
    expect(a.stage).toBe('attribution');
    const b = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source,
      checkpoint: a.checkpoint,
      response: JSON.stringify(attribution(source)),
    }) as Request;
    expect(b.stage).toBe('identity');
    const done = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source,
      checkpoint: b.checkpoint,
      response: JSON.stringify(identity(b)),
    });
    expect(done.kind).toBe('complete');
    if (done.kind !== 'complete') throw Error();
    expect(done.identities).toHaveLength(1);
    expect(done.labels.some((l) => l.speakerId === done.identities[0].id)).toBe(true);
    for (const l of done.labels)
      expect(
        source.chapter.paragraphs.find((p) => p.id === l.paragraphId)!.text.slice(l.startOffset, l.endOffset),
      ).toContain('안녕');
    const next = {
      ...source,
      chapter: {
        ...source.chapter,
        id: 'c2',
        index: 2,
        paragraphs: [{ id: 'p3', index: 1, text: '민아는 웃었다. “다시 만났네.”' }],
      },
    };
    const a2 = begin(next, done.ledger);
    const b2 = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: next,
      ledger: done.ledger,
      checkpoint: a2.checkpoint,
      response: JSON.stringify(attribution(next)),
    }) as Request;
    const d2 = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: next,
      ledger: done.ledger,
      checkpoint: b2.checkpoint,
      response: JSON.stringify(identity(b2, done.identities[0].id)),
    });
    expect(d2.kind === 'complete' && d2.identities.map((x) => x.id)).toEqual([done.identities[0].id]);
  });
  it('rejects incomplete, duplicate and foreign targets, and stale checkpoints', () => {
    const a = begin();
    const wire = attribution(source);
    for (const labels of [[], [...wire.labels, wire.labels[0]], [{ ...wire.labels[0], target_id: 'foreign' }]])
      expect(() =>
        step({
          protocol: SPEAKER_ENGINE_PROTOCOL,
          source,
          checkpoint: a.checkpoint,
          response: JSON.stringify({ ...wire, labels }),
        }),
      ).toThrow();
    expect(() =>
      step({ protocol: SPEAKER_ENGINE_PROTOCOL, source: { ...source, revision: 'changed' }, checkpoint: a.checkpoint }),
    ).toThrow('checkpoint_scope_changed');
  });
  it('advances narrator-only chapters without model calls', () => {
    const plain = {
      ...source,
      chapter: { ...source.chapter, paragraphs: [{ id: 'p', index: 1, text: '해가 떠올랐다.' }] },
    };
    expect(begin(plain).kind).toBe('complete');
  });
  it('requires B target coverage for UNKNOWN and retains narrator fallback source hashes', () => {
    const a = begin();
    const b = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source,
      checkpoint: a.checkpoint,
      response: JSON.stringify(attribution(source, 'UNKNOWN')),
    }) as Request;
    expect(b.stage).toBe('identity');
    expect(() =>
      step({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        source,
        checkpoint: b.checkpoint,
        response: JSON.stringify({ groups: [], target_labels: [] }),
      }),
    ).toThrow();
    const done = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source,
      checkpoint: b.checkpoint,
      response: JSON.stringify({
        groups: [],
        target_labels: prepare(source).input.targets.map((t) => ({
          target_id: t.targetId,
          local_speaker_id: 'UNKNOWN',
          disposition: 'EXTRA_UNSPECIFIED',
          review_required: false,
        })),
      }),
    });
    if (done.kind !== 'complete') throw Error('expected complete');
    expect(done.identities).toEqual([]);
    expect(done.labels).toHaveLength(prepare(source).input.targets.length);
    expect(done.labels.every((l) => l.speakerId === 'narrator' && l.reviewRequired)).toBe(true);
    expect(done.labels.map((l) => l.textHash)).toEqual(prepare(source).input.targets.map((t) => t.sourceSpanHash));
  });
  it('checkpoints both A chunks above 120 targets before running B with every target preserved', () => {
    const many = {
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
    const prepared = prepare(many);
    expect(prepared.initialStrategy).toBe('chunked');
    expect(prepared.fallbackUnits.map((u) => u.requestedTargetIds.length)).toEqual([100, 21]);
    let request = begin(many);
    for (const [index, unit] of prepared.fallbackUnits.entries()) {
      expect(request.stage).toBe('attribution');
      expect((request.checkpoint as { outputs: unknown[] }).outputs).toHaveLength(index);
      const wire = attribution(many);
      request = step({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        source: many,
        checkpoint: request.checkpoint,
        response: JSON.stringify({
          ...wire,
          labels: wire.labels.filter((l) => unit.requestedTargetIds.includes(l.target_id)),
        }),
      }) as Request;
    }
    expect(request.stage).toBe('identity');
    const wire = identity(request);
    wire.groups[0].member_local_speaker_ids = [...new Set(wire.groups[0].member_local_speaker_ids)];
    const done = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: many,
      checkpoint: request.checkpoint,
      response: JSON.stringify(wire),
    });
    if (done.kind !== 'complete') throw Error('expected complete');
    expect(done.labels).toHaveLength(121);
    expect(new Set(done.labels.map((l) => l.paragraphId)).size).toBe(121);
    expect(new Set(done.labels.map((l) => l.speakerId))).toEqual(new Set(done.identities.map((i) => i.id)));
  });
});
