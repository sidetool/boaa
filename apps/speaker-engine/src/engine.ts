import { structuredIntegrityHash, textIntegrityHash } from '@boaa/text-core/hash';
import { buildSpeakerSceneInventory, buildSpeakerSpanInventory } from '@boaa/text-core/speaker-attribution';
import {
  SPEAKER_ENGINE_PROTOCOL,
  type SpeakerEngineStep,
  type SpeakerEngineResult,
  type SpeakerEngineSource,
  type SpeakerChapter,
} from '../../../src/providers/speaker-engine-protocol';
import * as a from './preset35/chapter-context-speaker';
import * as b from './preset35/sequential-identity-core';

export const ENGINE_VERSION = 'preset35-boaa-1';
type Checkpoint = {
  version: string;
  fingerprint: string;
  phase: 'attribution' | 'identity';
  outputs: a.SpeakerChapterLabelV1[];
};
function paragraphs(chapter: SpeakerChapter) {
  let offset = 0;
  return chapter.paragraphs.map((p) => {
    const start = offset;
    offset += p.text.length + 1;
    return {
      paragraphId: p.id,
      chapterId: chapter.id,
      paragraphIndex: p.index,
      text: p.text,
      textHash: textIntegrityHash(p.text),
      startOffsetInChapter: start,
      endOffsetInChapter: offset - 1,
    };
  });
}
export function prepare(source: SpeakerEngineSource): a.PreparedChapterSpeakerRun {
  const chapter = source.chapter;
  if (
    !source.scope ||
    !source.revision ||
    !chapter?.id ||
    !Number.isSafeInteger(chapter.index) ||
    chapter.index < 1 ||
    !Array.isArray(chapter.paragraphs) ||
    chapter.paragraphs.length > 10000 ||
    chapter.paragraphs.some(
      (p) => !p.id || typeof p.text !== 'string' || !Number.isSafeInteger(p.index) || p.index < 1,
    ) ||
    new Set(chapter.paragraphs.map((p) => p.id)).size !== chapter.paragraphs.length ||
    chapter.paragraphs.reduce((n, p) => n + p.text.length, 0) > 120000
  )
    throw new Error('invalid_source');
  const ps = paragraphs(chapter);
  const base = { bookId: source.scope, contentRevisionId: source.revision, chapterId: chapter.id, paragraphs: ps };
  const sceneInventory = buildSpeakerSceneInventory({ ...base, chapterIndex: chapter.index });
  const inventory = buildSpeakerSpanInventory({ ...base, sceneInventory, detectionProfile: 'broad_tts_candidate' });
  const spans = inventory.spans.filter((s) => s.voiceBearing);
  const adjacent = (c?: SpeakerChapter) =>
    c ? { chapterId: c.id, chapterIndex: c.index, title: c.title, paragraphs: paragraphs(c) } : undefined;
  const core = {
    version: a.CHAPTER_SPEAKER_INPUT_VERSION_PRESET_3_E1,
    corpusFingerprint: structuredIntegrityHash({ scope: source.scope, revision: source.revision }),
    sourceRevision: structuredIntegrityHash(base),
    graphFingerprint: a.CHAPTER_LOCAL_IDENTITY_FINGERPRINT,
    identityMemoryPolicy: 'chapter_local_only' as const,
    chapter: { chapterId: chapter.id, chapterIndex: chapter.index, titleHash: textIntegrityHash(chapter.title) },
    paragraphs: ps.map((p) => ({
      ...p,
      sceneId: sceneInventory.scenes.find((s) => s.paragraphIds.includes(p.paragraphId))!.id,
      annotatedText: a.annotateParagraph(
        p.text,
        inventory.spans.filter((s) => s.paragraphId === p.paragraphId),
        true,
      ),
    })),
    targets: spans.map((s) => ({
      targetId: s.id,
      sourceSpanHash: s.textHash,
      paragraphId: s.paragraphId,
      spanIndex: s.spanIndex,
      startOffset: s.startOffset,
      endOffset: s.endOffset,
      sceneId: s.sceneId,
      channelType: s.type,
      candidateHint: s.boundaryCode,
      boundaryReview: s.boundaryReview,
    })),
    identityIndex: a.buildChapterLocalIdentityIndex({
      corpusFingerprint: structuredIntegrityHash({ scope: source.scope, revision: source.revision }),
      chapterIndex: chapter.index,
    }),
    lockedLabels: spans.flatMap((s) =>
      s.deterministicSpeaker === 'narrator' || s.deterministicSpeaker === 'system'
        ? [
            {
              targetId: s.id,
              speakerRef: s.deterministicSpeaker === 'narrator' ? ('NARRATOR' as const) : ('SYSTEM' as const),
            },
          ]
        : [],
    ),
    adjacentContext: a.buildChapterAdjacentContext({
      policy: 'previous_tail_next_head',
      currentChapterCharacterCount: ps.reduce((n, p) => n + p.text.length, 0),
      previous: adjacent(source.previous),
      next: adjacent(source.next),
    }),
  };
  const input = { ...core, fingerprint: structuredIntegrityHash(core) };
  const initialStrategy = a.chapterSpeakerInitialStrategy(spans.length);
  return {
    runId: input.fingerprint,
    presetId: a.CHAPTER_SPEAKER_PRESET_3.id,
    modelId: a.CHAPTER_SPEAKER_MODEL_ID,
    promptMode: 'chapter_primary',
    initialStrategy,
    executionProfileVersion: a.CHAPTER_SPEAKER_LOCAL_IDENTITY_PROFILE_VERSION,
    input,
    ...a.planChapterSpeakerUnits(
      spans.map((s) => s.id),
      input.fingerprint,
      initialStrategy === 'chunked',
    ),
  };
}

/** One model request at a time. BOAA durably saves each accepted step and owns retries and credentials. */
export function step(input: SpeakerEngineStep): SpeakerEngineResult {
  if (input.protocol !== SPEAKER_ENGINE_PROTOCOL) throw new Error('unsupported_protocol');
  const prepared = prepare(input.source);
  const fingerprint = structuredIntegrityHash({
    engine: ENGINE_VERSION,
    source: prepared.input.fingerprint,
    ledger: input.ledger ?? null,
  });
  const checkpoint = (input.checkpoint ?? {
    version: ENGINE_VERSION,
    fingerprint,
    phase: 'attribution',
    outputs: [],
  }) as Checkpoint;
  if (
    checkpoint.version !== ENGINE_VERSION ||
    checkpoint.fingerprint !== fingerprint ||
    !Array.isArray(checkpoint.outputs) ||
    !['attribution', 'identity'].includes(checkpoint.phase)
  )
    throw new Error('checkpoint_scope_changed');
  const units = prepared.initialStrategy === 'chunked' ? prepared.fallbackUnits : [prepared.fullUnit];
  let outputs = checkpoint.outputs;
  if (checkpoint.phase === 'attribution' && input.response !== undefined) {
    const unit = units[outputs.length];
    if (!unit) throw new Error('unexpected_attribution_response');
    outputs = [
      ...outputs,
      a.validateChapterSpeakerWire({ prepared, unit, wire: a.parseChapterSpeakerWire(input.response) }),
    ];
  }
  if (prepared.input.targets.length && outputs.length < units.length) {
    const request = a.buildChapterSpeakerRequest({ prepared, unit: units[outputs.length] });
    return {
      kind: 'request',
      stage: 'attribution',
      checkpoint: { ...checkpoint, outputs },
      prompt: request.prompt,
      schema: request.responseSchema,
    };
  }
  const labels = a.combineChapterSpeakerLabels({ prepared, outputs });
  const ledger = (input.ledger ??
    b.createEmptySequentialIdentityLedger(
      prepared.input.corpusFingerprint,
      a.CHAPTER_SPEAKER_PRESET_3.id,
    )) as b.SequentialIdentityLedgerV1;
  const block = b.prepareSequentialIdentityBlock({
    priorLedger: ledger,
    memoryMode: 'compact_lorebook',
    chapters: [
      {
        prepared,
        checkpoint: {
          runId: prepared.runId,
          inputFingerprint: prepared.input.fingerprint,
          status: 'succeeded',
          finalLabels: labels,
        },
        chapterTitle: input.source.chapter.title,
      },
    ],
  });
  if (checkpoint.phase !== 'identity' || input.response === undefined) {
    // Even target-free chapters advance sequential memory, without a billable request.
    if (
      block.input.localSpeakers.length ||
      block.input.chapterSources.some((c) => c.targetAssignments.some((t) => t.assignmentKind === 'unknown'))
    )
      return {
        kind: 'request',
        stage: 'identity',
        checkpoint: { ...checkpoint, outputs, phase: 'identity' },
        prompt: b.buildSequentialIdentityPrompt(block),
        schema: b.sequentialIdentityResponseSchema,
      };
  }
  const wire = b.parseSequentialIdentityWire(
    checkpoint.phase === 'identity' && input.response !== undefined
      ? input.response
      : { groups: [], target_labels: [] },
  );
  const result = b.applySequentialIdentityWire({ prepared: block, priorLedger: ledger, wire });
  return {
    kind: 'complete',
    ledger: result.ledger,
    identities: result.ledger.entries.map((e) => ({
      id: e.workSpeakerId,
      name: e.canonicalDisplay,
      reviewRequired: e.reviewRequired,
    })),
    labels: prepared.input.targets.map((t) => {
      const label = labels.labels.find((l) => l.targetId === t.targetId)!;
      const localId = label.selection.kind === 'speaker' ? label.selection.speakerEntityId : undefined;
      const mapping = result.ledger.mappings.find(
        (m) => m.chapterIndex === input.source.chapter.index && m.localSpeakerId === localId,
      );
      const disposition = result.ledger.targetDispositions.find((d) => d.targetId === t.targetId);
      const identity = result.ledger.entries.find((e) => e.workSpeakerId === mapping?.workSpeakerId);
      return {
        paragraphId: t.paragraphId,
        startOffset: t.startOffset,
        endOffset: t.endOffset,
        textHash: t.sourceSpanHash,
        speakerId:
          !disposition && mapping && !mapping.reviewRequired && !identity?.reviewRequired
            ? mapping.workSpeakerId
            : 'narrator',
        reviewRequired:
          !!disposition?.reviewRequired ||
          !!mapping?.reviewRequired ||
          !!identity?.reviewRequired ||
          label.selection.kind === 'unknown',
      };
    }),
  };
}
