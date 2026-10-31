import type { SpokenTextRule, TTSFootnotePlaybackPolicy } from '../domain/types';
import type { PlainTTSModel } from './plain-tts';
import type { PlayableTtsSegment } from './tts-playback';
import type { SpeakerGenerationSettings } from './speaker-generation';

/** Ordinary narration saved on the account's server, independently of disposable caches. */
export interface AudiobookInput {
  /** Server-owned, enabled only by the explicit skip-blocked control action. */
  skipBlockedAudio?: boolean;
  /** Trusted server plan only. Ordinary creation routes never accept this field. */
  cast?: SpeakerGenerationSettings;
  chapterIds: string[];
  voiceId: string;
  modelRevision: string;
  chunking: 'sentence' | 'paragraph' | 'batch';
  batchCharacters?: number;
  footnotePlayback: TTSFootnotePlaybackPolicy;
  rules: readonly SpokenTextRule[];
  /** Set by the server from the chosen voice, never from unrelated catalog entries. */
  model?: PlainTTSModel;
}

export interface PreparedNarration {
  id: string;
  chapterId: string;
  contentRevision?: string;
  skippedItems?: number;
  voiceLabel: string;
  items: { ordinal: number; paragraphIndex: number; nextParagraphIndex: number; playable: PlayableTtsSegment }[];
}

export interface AudiobookEstimate {
  fingerprint: string;
  chapterCount: number;
  itemCount: number;
  characters: number;
  voiceLabel: string;
  providerName: string;
  paid: boolean;
  firstChapterTitle?: string;
  lastChapterTitle?: string;
}

export type AudiobookStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'failed' | 'completed' | 'deleting';
export interface SavedAudiobook extends AudiobookEstimate {
  id: string;
  bookId: string;
  chapterIds?: readonly string[];
  title: string;
  status: AudiobookStatus;
  completedItems: number;
  blockedItems?: number;
  skippedItems?: number;
  skipBlockedAudio?: boolean;
  blockedAudio?: { ordinal: number; chapterTitle: string; reason: string }[];
  skippedAudio?: { ordinal: number; chapterTitle: string; reason: string }[];
  bytes: number;
  playbackIndex: number;
  currentChapterTitle?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AudiobookPort {
  list(signal?: AbortSignal): Promise<SavedAudiobook[]>;
  estimate(input: AudiobookInput, signal?: AbortSignal): Promise<AudiobookEstimate>;
  create(
    input: AudiobookInput,
    fingerprint: string,
    confirmPaid: boolean,
    signal?: AbortSignal,
  ): Promise<SavedAudiobook>;
  control(id: string, action: 'pause' | 'resume' | 'skip-blocked', confirmPaid?: boolean): Promise<SavedAudiobook>;
  remove(id: string): Promise<void>;
  audio(id: string, index: number, signal?: AbortSignal): Promise<Blob>;
  progress(id: string, index: number): Promise<void>;
  reader(
    chapterId: string,
    choice: { id?: string; voiceId?: string },
    signal?: AbortSignal,
  ): Promise<PreparedNarration | undefined>;
  resolve(id: string, index: number, regenerate?: boolean, signal?: AbortSignal): Promise<Blob>;
}
