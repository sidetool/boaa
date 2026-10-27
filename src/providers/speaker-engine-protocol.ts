/** Service-neutral boundary. Offsets refer to unchanged paragraph UTF-16 text, end exclusive. */
export const SPEAKER_ENGINE_PROTOCOL = 'boaa-speaker-engine-v1';
export interface SpeakerChapter {
  id: string;
  index: number;
  title: string;
  paragraphs: { id: string; index: number; text: string }[];
}
export interface SpeakerEngineSource {
  scope: string;
  revision: string;
  chapter: SpeakerChapter;
  previous?: SpeakerChapter;
  next?: SpeakerChapter;
}
export interface SpeakerLabel {
  paragraphId: string;
  startOffset: number;
  endOffset: number;
  textHash: string;
  speakerId: string;
  reviewRequired: boolean;
}
export interface SpeakerIdentity {
  id: string;
  name: string;
  reviewRequired: boolean;
}
export interface SpeakerEngineStep {
  protocol: typeof SPEAKER_ENGINE_PROTOCOL;
  source: SpeakerEngineSource;
  ledger?: unknown;
  checkpoint?: unknown;
  response?: string;
}
export type SpeakerEngineResult =
  | {
      kind: 'request';
      stage: 'attribution' | 'identity';
      checkpoint: unknown;
      prompt: string;
      schema: Record<string, unknown>;
    }
  | {
      kind: 'complete';
      ledger: unknown;
      labels: SpeakerLabel[];
      identities: SpeakerIdentity[];
    };
