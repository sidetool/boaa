import type { AudiobookInput, SavedAudiobook } from './plain-audiobook';
import type { PlainTTSModel, PlainTTSVoices } from './plain-tts';
import type { SpeakerEnginesPort } from './speaker-engine';
import type { SpeakerCastingOptions, VoiceLibraryPort, BookVoiceAssignment } from './voice-library';

/** Independent book-wide cleanup choices. Shared connections and the account voice library are never deleted. */
export interface SpeakerCleanupOptions {
  audio: boolean;
  settings: boolean;
  analysis: boolean;
}
export interface SpeakerCleanupPreview {
  fingerprint: string;
  jobCount: number;
  audioBytes: number;
  assignmentCount: number;
  analysisCount: number;
  blockedReason?: string;
}
export interface SpeakerCleanupResult {
  removedJobs: number;
  removedAssignments: number;
  removedAnalyses: number;
  preferences?: SpeakerGenerationPreferences;
}

/** The regular narrator voice is also the conservative fallback for uncertain attribution. */
export interface SpeakerGenerationInput {
  /** Opt-in grouping of adjacent Gemini speech with identical voice and delivery; absent means off. */
  batchAudio?: boolean;
  chapterIds: string[];
  engineId: string;
  narratorVoiceId: string;
  characterVoiceIds: string[];
  casting?: SpeakerCastingOptions;
  autoActing?: boolean;
  /** Separate pass reuses speaker analysis and directs delivery after attribution. */
  actingMode?: 'inline' | 'separate';
  actingEngineId?: string;
  rules: AudiobookInput['rules'];
  footnotePlayback: AudiobookInput['footnotePlayback'];
}
export interface SpeakerGenerationEstimate {
  actingModelLabel?: string;
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
  /** All planned segments are saved or explicitly skipped, with at least one saved audio file. */
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
  batchAudio?: boolean;
  /** Explicit targets: each selected character gets a newly designed voice, including pinned voices. */
  designSpeakerIds?: string[];
  /** Apply changed character voices to future generation; existing audio remains immutable. */
  applyToBook?: boolean;
  acting?: { mode: 'preserve' | 'off' | 'auto' | 'regenerate'; engineId?: string };
  casting?: SpeakerCastingOptions;
  voices: { speakerId: string; voiceId: string; instructions?: string }[];
}
export interface SpeakerRevoiceSource {
  /** True when the captured audio actually contains grouped source spans. */
  batched?: boolean;
  /** Narrator model context, including dialogue-only jobs with no narrator row. */
  narratorVoiceId?: string;
  hasActing?: boolean;
  needsActing?: boolean;
  actingEngineId?: string;
  chapterCount: number;
  itemCount: number;
  /** Captured on this job's planned audio, independent of later book-wide assignments. */
  voices: {
    speakerId: string;
    name: string;
    voiceId: string;
    instructions?: string;
    itemCount: number;
    importance?: 'major' | 'supporting' | 'extra';
    pinned?: boolean;
    designed?: boolean;
  }[];
}
export interface SpeakerRevoiceEstimate {
  actingModelLabel?: string;
  actingAnalysis?: boolean;
  recastCharacters?: number;
  selectionModelLabel?: string;
  maxDesignedVoices?: number;
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
  control(
    id: string,
    action: 'pause' | 'resume' | 'skip-blocked',
    confirmPaid?: boolean,
  ): Promise<SpeakerGenerationJob>;
  remove(id: string): Promise<void>;
  castings?(id: string, signal?: AbortSignal): Promise<BookVoiceAssignment[]>;
  assign?(id: string, speakerId: string, voiceId: string, signal?: AbortSignal): Promise<void>;
  previewCleanup?(options: SpeakerCleanupOptions, signal?: AbortSignal): Promise<SpeakerCleanupPreview>;
  cleanup?(
    options: SpeakerCleanupOptions,
    fingerprint: string,
    confirm: boolean,
    signal?: AbortSignal,
  ): Promise<SpeakerCleanupResult>;
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
  batchAudio?: boolean;
  engineId: string;
  narratorVoiceId: string;
  characterVoiceIds: string[];
  casting?: SpeakerCastingOptions;
  autoActing?: boolean;
  /** Separate pass reuses speaker analysis and directs delivery after attribution. */
  actingMode?: 'inline' | 'separate';
  actingEngineId?: string;
}
export interface TTSSpeakerGenerationControls {
  key: string;
  port: SpeakerGenerationPort;
  engines: SpeakerEnginesPort;
  voiceLibrary?: VoiceLibraryPort;
  beforePreview?(): void | Promise<void>;
  /** Fixed-sentence sample of a listed voice; read-only, never touches the library or assignments. */
  previewVoice?(voiceId: string, signal: AbortSignal): Promise<Blob>;
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
  batchAudio?: boolean;
  /** Audio-only variant; all source-verified ranges were copied from this job. */
  revoiceFrom?: string;
  recastSpeakers?: string[];
  /** Immutable explicit targets; unlike recastSpeakers this survives batch completion. */
  designSpeakerIds?: string[];
  applyToBook?: boolean;
  /** Optimistic checks prevent delayed design completion from replacing a newer manual choice. */
  bookVoiceVersions?: Record<string, string>;
  /** Keeps pre-upgrade paid selection checkpoints addressable on resume. */
  voiceEvidenceVersion?: 2;
  autoActing?: boolean;
  actingMode?: 'inline' | 'separate';
  actingEngine?: { id: string; revision: string };
  language?: string;
  engineId: string;
  engineRevision: string;
  engineVersion: string;
  characterVoiceIds: string[];
  models: Record<string, PlainTTSModel>;
  casting?: SpeakerCastingOptions & { engineRevision?: string; designModel?: PlainTTSModel };
}
