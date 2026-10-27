// Adapted from the Apache-2.0 preset35 reference; see ../../NOTICE.
export const CHAPTER_IDENTITY_RESULT_VERSION = 'chapter-identity-result-v3-extra-labels' as const;

export const EXTRA_SPEAKER_DISPOSITIONS = [
  'extra_child_male',
  'extra_child_female',
  'extra_adolescent_male',
  'extra_adolescent_female',
  'extra_young_adult_male',
  'extra_young_adult_female',
  'extra_middle_aged_male',
  'extra_middle_aged_female',
  'extra_elderly_male',
  'extra_elderly_female',
  'extra_unspecified',
] as const;

export type ExtraSpeakerDispositionV1 = (typeof EXTRA_SPEAKER_DISPOSITIONS)[number];

export type SpeakerTargetDispositionV1 = ExtraSpeakerDispositionV1 | 'non_speech' | 'needs_identity_review';

export function isExtraSpeakerDisposition(value: SpeakerTargetDispositionV1): value is ExtraSpeakerDispositionV1 {
  return EXTRA_SPEAKER_DISPOSITIONS.some((candidate) => candidate === value);
}

export interface ChapterIdentityResultV1 {
  readonly version: typeof CHAPTER_IDENTITY_RESULT_VERSION;
  readonly runId: string;
  readonly inputFingerprint: string;
  readonly groups: readonly {
    readonly workSpeakerId: string;
    readonly canonicalDisplay: string;
    readonly aliases: readonly string[];
    readonly memberLocalSpeakerIds: readonly string[];
    readonly reviewRequired: boolean;
  }[];
  readonly targetDispositions: readonly {
    readonly targetId: string;
    readonly sourceSpanHash: string;
    readonly chapterIndex: number;
    readonly localSpeakerId: string;
    readonly disposition: SpeakerTargetDispositionV1;
    readonly reviewRequired: boolean;
  }[];
  readonly extraSpeakerCasts?: readonly {
    readonly localSpeakerId: string;
    readonly chapterIndex: number;
    readonly display: string;
    readonly disposition: ExtraSpeakerDispositionV1;
    readonly targetIds: readonly string[];
  }[];
  readonly fingerprint: string;
}
