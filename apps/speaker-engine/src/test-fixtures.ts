import { prepare } from './engine';
import type { SpeakerEngineSource, SpeakerEngineResult } from '../../../src/providers/speaker-engine-protocol';
type Request = Extract<SpeakerEngineResult, { kind: 'request' }>;
export const source: SpeakerEngineSource = {
  scope: 'fixture-book',
  revision: 'rev',
  chapter: {
    id: 'c1',
    index: 1,
    title: '출발',
    paragraphs: [
      { id: 'p1', index: 1, text: '민아가 말했다. “안녕 🌙.” 잠시 쉬었다.' },
      { id: 'p2', index: 2, text: '해가 떠올랐다.' },
    ],
  },
};
export function attribution(s: SpeakerEngineSource, ref = 'NEW_1') {
  const p = prepare(s);
  return {
    chapter_id: s.chapter.id,
    labels: p.input.targets.map((t) => ({
      target_id: t.targetId,
      speaker_ref: p.input.lockedLabels.find((l) => l.targetId === t.targetId)?.speakerRef ?? ref,
    })),
    new_speakers:
      ref === 'NEW_1'
        ? [
            {
              local_ref: 'NEW_1',
              kind: 'NEW_FROM_TEXT',
              surface: '민아',
              anchor_paragraph_id: s.chapter.paragraphs[0].id,
            },
          ]
        : [],
  };
}
export function identity(request: Request, existing = 'NONE') {
  const checkpoint = request.checkpoint as { outputs: { provisionalSpeakers: { speakerEntityId: string }[] }[] };
  const ids = checkpoint.outputs.flatMap((o) => o.provisionalSpeakers.map((s) => s.speakerEntityId));
  return {
    groups: ids.length
      ? [
          {
            group_ref: 'G1',
            action: existing === 'NONE' ? 'CREATE_NEW' : 'LINK_EXISTING',
            existing_work_speaker_id: existing,
            canonical_display: '민아',
            member_local_speaker_ids: ids,
            review_required: false,
          },
        ]
      : [],
    target_labels: [],
  };
}
