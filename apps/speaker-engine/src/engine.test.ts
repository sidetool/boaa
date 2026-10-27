import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, prepare, step } from './engine';
import type { SequentialIdentityLedgerV1 } from './preset35/sequential-identity-core';
import { SPEAKER_ENGINE_PROTOCOL, type SpeakerEngineResult } from '../../../src/providers/speaker-engine-protocol';

type Request = Extract<SpeakerEngineResult, { kind: 'request' }>;
import { source, attribution, identity } from './test-fixtures';
function begin(s = source, ledger?: unknown) {
  return step({ protocol: SPEAKER_ENGINE_PROTOCOL, source: s, ledger }) as Request;
}
describe('real preset35 adapter', () => {
  it('requires compact-lorebook retrieval terms in the B schema and rejects a model reply that omits them', () => {
    const a = begin();
    expect(ENGINE_VERSION).toBe('preset35-boaa-2');
    expect(a.checkpoint).toMatchObject({ version: ENGINE_VERSION });
    const b = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source,
      checkpoint: a.checkpoint,
      response: JSON.stringify(attribution(source)),
    }) as Request;
    expect(b.stage).toBe('identity');
    expect(b.schema).toMatchObject({
      properties: {
        groups: {
          items: {
            required: expect.arrayContaining(['retrieval_terms']),
            properties: { retrieval_terms: { type: 'ARRAY', items: { type: 'STRING' } } },
          },
        },
      },
    });
    const valid = identity(b);
    const { retrieval_terms: _terms, ...missing } = valid.groups[0];
    expect(() =>
      step({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        source,
        checkpoint: b.checkpoint,
        response: JSON.stringify({ ...valid, groups: [missing] }),
      }),
    ).toThrow('speaker_engine_lorebook_retrieval_terms_required');
    expect(
      step({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        source,
        checkpoint: b.checkpoint,
        response: JSON.stringify({ ...valid, groups: [{ ...valid.groups[0], retrieval_terms: [] }] }),
      }).kind,
    ).toBe('complete');
  });
  it('retains only source-grounded retrieval phrases and activates that identity by its role in the next chapter', () => {
    const roleSource = {
      ...source,
      chapter: {
        ...source.chapter,
        paragraphs: [{ id: 'p1', index: 1, text: '민아가 말했다. 별빛 우체부가 전할 소식이었다. “안녕 🌙.”' }],
      },
    };
    const a = begin(roleSource);
    const b = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: roleSource,
      checkpoint: a.checkpoint,
      response: JSON.stringify(attribution(roleSource)),
    }) as Request;
    const wire = identity(b);
    wire.groups[0].retrieval_terms = ['별빛 우체부', '근거 없는 용병단장'];
    const done = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: roleSource,
      checkpoint: b.checkpoint,
      response: JSON.stringify(wire),
    });
    if (done.kind !== 'complete') throw Error('expected complete');
    const ledger = done.ledger as SequentialIdentityLedgerV1;
    expect(ledger.entries[0].retrievalTerms).toEqual(['별빛 우체부']);
    expect(ledger.entries[0].aliases).not.toContain('별빛 우체부');
    const next = {
      ...roleSource,
      chapter: {
        ...roleSource.chapter,
        id: 'c2',
        index: 2,
        paragraphs: [{ id: 'p3', index: 1, text: '별빛 우체부가 웃었다. “다시 만났네.”' }],
      },
    };
    expect(next.chapter.paragraphs[0].text).not.toContain('민아');
    const a2 = begin(next, ledger);
    const nextWire = attribution(next);
    nextWire.new_speakers[0].surface = '별빛 우체부';
    const b2 = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: next,
      ledger,
      checkpoint: a2.checkpoint,
      response: JSON.stringify(nextWire),
    }) as Request;
    expect(b2.stage).toBe('identity');
    const packet = JSON.parse(b2.prompt.split('\nSOURCE_JSON=')[1]);
    expect(packet.activated_prior_identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          work_speaker_id: done.identities[0].id,
          retrieval_terms: ['별빛 우체부'],
          activation_reasons: expect.arrayContaining(['local_retrieval_term_match', 'source_retrieval_term_match']),
        }),
      ]),
    );
    const linked = step({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      source: next,
      ledger,
      checkpoint: b2.checkpoint,
      response: JSON.stringify(identity(b2, done.identities[0].id)),
    });
    if (linked.kind !== 'complete') throw Error('expected linked identity');
    expect(linked.identities.map((i) => i.id)).toEqual([done.identities[0].id]);
    expect(linked.labels.every((l) => l.speakerId === done.identities[0].id)).toBe(true);
  });
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
