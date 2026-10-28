import type { AudiobookInput, SavedAudiobook } from './plain-audiobook';
import type { PlainTTSModel, PlainTTSVoices } from './plain-tts';
import type { SpeakerEnginesPort } from './speaker-engine';
import type { SpeakerCastingOptions, VoiceLibraryPort, BookVoiceAssignment } from './voice-library';

/** The regular narrator voice is also the conservative fallback for uncertain attribution. */
export interface SpeakerGenerationInput {
  chapterIds: string[];
  engineId: string;
  narratorVoiceId: string;
  characterVoiceIds: string[];
  casting?: SpeakerCastingOptions;
  autoActing?: boolean;
  rules: AudiobookInput['rules'];
  footnotePlayback: AudiobookInput['footnotePlayback'];
}
export interface SpeakerGenerationEstimate {
  fingerprint: string;
  chapterCount: number;
  contextChapterCount: number;
  characters: number;
  modelLabel: string;
  voiceLabel: string;
  paid: boolean;
  selectionModelLabel?: string;
  maxDesignedVoices?: number;
}
export interface SpeakerGenerationJob extends SavedAudiobook {
  revoiceFrom?: string;
  stage: 'waiting' | 'attribution' | 'identity' | 'casting' | 'performance' | 'audio' | 'complete';
  analyzedChapters: number;
  contextChapterCount: number;
  readyChapterIds: string[];
  castVoiceIds?: string[];
  /** Includes earlier chapters needed to identify recurring characters. */
  analysisProgress?: {
    chapterCount: number;
    attributionCompleted?: number;
    currentChapter?: { number: number; title: string; contextOnly: boolean };
  };
  /** False means itemCount covers only the chapters planned so far. */
  planningComplete?: boolean;
  retryAt?: string;
}
export interface SpeakerRevoiceInput {
  acting?: { mode: 'preserve' | 'off' | 'auto'; engineId?: string };
  voices: { speakerId: string; voiceId: string; instructions?: string }[];
}
export interface SpeakerRevoiceSource {
  hasActing?: boolean;
  needsActing?: boolean;
  actingEngineId?: string;
  chapterCount: number;
  itemCount: number;
  /** Captured on this job's planned audio, independent of later book-wide assignments. */
  voices: { speakerId: string; name: string; voiceId: string; instructions?: string; itemCount: number }[];
}
export interface SpeakerRevoiceEstimate {
  actingAnalysis?: boolean;
  fingerprint: string;
  chapterCount: number;
  itemCount: number;
  characters: number;
  paid: boolean;
}
export interface SpeakerGenerationPort {
  preferences(signal?: AbortSignal): Promise<SpeakerGenerationPreferences | undefined>;
  savePreferences(value: SpeakerGenerationPreferences, signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<SpeakerGenerationJob[]>;
  estimate(input: SpeakerGenerationInput, signal?: AbortSignal): Promise<SpeakerGenerationEstimate>;
  create(
    input: SpeakerGenerationInput,
    fingerprint: string,
    confirmPaid: boolean,
    signal?: AbortSignal,
  ): Promise<SpeakerGenerationJob>;
  control(id: string, action: 'pause' | 'resume', confirmPaid?: boolean): Promise<SpeakerGenerationJob>;
  remove(id: string): Promise<void>;
  castings?(id: string, signal?: AbortSignal): Promise<BookVoiceAssignment[]>;
  assign?(id: string, speakerId: string, voiceId: string, signal?: AbortSignal): Promise<void>;
  revoiceSource?(id: string, signal?: AbortSignal): Promise<SpeakerRevoiceSource>;
  estimateRevoice?(id: string, input: SpeakerRevoiceInput, signal?: AbortSignal): Promise<SpeakerRevoiceEstimate>;
  revoice?(
    id: string,
    input: SpeakerRevoiceInput,
    fingerprint: string,
    confirmPaid: boolean,
    signal?: AbortSignal,
  ): Promise<SpeakerGenerationJob>;
}
export interface SpeakerGenerationPreferences {
  engineId: string;
  narratorVoiceId: string;
  characterVoiceIds: string[];
  casting?: SpeakerCastingOptions;
  autoActing?: boolean;
}
export interface TTSSpeakerGenerationControls {
  key: string;
  port: SpeakerGenerationPort;
  engines: SpeakerEnginesPort;
  voiceLibrary?: VoiceLibraryPort;
  beforePreview?(): void | Promise<void>;
  chapters: readonly { id: string; title: string }[];
  currentChapterId?: string;
  voices?: PlainTTSVoices;
  narratorVoiceId?: string;
  rules: AudiobookInput['rules'];
  footnotePlayback: AudiobookInput['footnotePlayback'];
  listen(job: SpeakerGenerationJob): void | Promise<void>;
  refreshVoices(): void | Promise<void>;
}
/** Server-only pinned identity; not accepted from public create requests. */
export interface SpeakerGenerationSettings {
  /** Audio-only variant; all source-verified ranges were copied from this job. */
  revoiceFrom?: string;
  autoActing?: boolean;
  actingEngine?: { id: string; revision: string };
  language?: string;
  engineId: string;
  engineRevision: string;
  engineVersion: string;
  characterVoiceIds: string[];
  models: Record<string, PlainTTSModel>;
  casting?: SpeakerCastingOptions & { engineRevision?: string; designModel?: PlainTTSModel };
}
