import type { SpokenTextRule, TTSFootnotePlaybackPolicy } from '../domain/types';

/** Ordinary narration saved on the account's server, independently of disposable caches. */
export interface AudiobookInput {
  chapterIds: string[];
  voiceId: string;
  modelRevision: string;
  chunking: 'sentence' | 'paragraph' | 'batch';
  batchCharacters?: number;
  footnotePlayback: TTSFootnotePlaybackPolicy;
  rules: readonly SpokenTextRule[];
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
  title: string;
  status: AudiobookStatus;
  completedItems: number;
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
  control(id: string, action: 'pause' | 'resume', confirmPaid?: boolean): Promise<SavedAudiobook>;
  remove(id: string): Promise<void>;
  audio(id: string, index: number, signal?: AbortSignal): Promise<Blob>;
  progress(id: string, index: number): Promise<void>;
}
