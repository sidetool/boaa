import type { PlainTTSModel } from './plain-tts';

/** Presentation metadata never participates in synthesis identity. */
export interface VoiceLibraryInput {
  voiceId: string;
  alias: string;
  timbre: string;
  description: string;
  language: string;
  enabled: boolean;
}
export interface LibraryVoice extends VoiceLibraryInput {
  id: string;
  providerId: string;
  providerVoiceId: string;
  model: PlainTTSModel;
  origin: 'catalog' | 'designed';
  designPrompt?: string;
  sampleAvailable: boolean;
  available: boolean;
  createdAt: string;
}
export interface VoiceDesignInput {
  /** A stable operation id prevents a lost HTTP response from creating another paid voice. */
  requestId: string;
  providerId: string;
  modelId: string;
  alias: string;
  prompt: string;
  language: string;
  confirmPaid: boolean;
}
export interface VoiceDesignProvider {
  id: string;
  name: string;
  modelId: string;
  paid: boolean;
}
export interface VoiceLibraryPort {
  list(signal?: AbortSignal): Promise<{ voices: LibraryVoice[]; designers: VoiceDesignProvider[] }>;
  save(input: VoiceLibraryInput, signal?: AbortSignal, id?: string): Promise<LibraryVoice>;
  remove(id: string, signal?: AbortSignal): Promise<void>;
  design(input: VoiceDesignInput, signal?: AbortSignal): Promise<LibraryVoice>;
  sample(id: string, signal?: AbortSignal): Promise<Blob>;
}
export interface SpeakerCastingOptions {
  /** Independent of the attribution model. Omit for stable, cost-free pool allocation. */
  engineId?: string;
  autoDesign: boolean;
  designProviderId?: string;
  designModelId?: string;
  /** Budget for this job; existing book assignments and extras reuse voices. */
  maxDesignedVoices: number;
}
export interface BookVoiceAssignment {
  speakerId: string;
  name: string;
  voiceId: string;
  alias: string;
  timbre: string;
  description: string;
  importance: 'major' | 'supporting' | 'extra';
  pinned: boolean;
}
