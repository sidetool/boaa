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
  stage: 'waiting' | 'attribution' | 'identity' | 'casting' | 'audio' | 'complete';
  analyzedChapters: number;
  contextChapterCount: number;
  readyChapterIds: string[];
  castVoiceIds?: string[];
  /** Includes earlier chapters needed to identify recurring characters. */
  analysisProgress?: {
    chapterCount: number;
    currentChapter?: { number: number; title: string; contextOnly: boolean };
  };
  /** False means itemCount covers only the chapters planned so far. */
  planningComplete?: boolean;
  retryAt?: string;
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
}
export interface SpeakerGenerationPreferences {
  engineId: string;
  narratorVoiceId: string;
  characterVoiceIds: string[];
  casting?: SpeakerCastingOptions;
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
  language?: string;
  engineId: string;
  engineRevision: string;
  engineVersion: string;
  characterVoiceIds: string[];
  models: Record<string, PlainTTSModel>;
  casting?: SpeakerCastingOptions & { engineRevision?: string; designModel?: PlainTTSModel };
}
