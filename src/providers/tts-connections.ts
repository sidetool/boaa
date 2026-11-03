/** Administrator-managed TTS connections. Credentials never belong in browser storage. */
export interface TTSConnectionVoice {
  readonly id: string;
  readonly label: string;
  readonly lang?: string;
}

export interface TTSConnectionInput {
  readonly name: string;
  readonly protocol: 'local' | 'openai' | 'fish' | 'openrouter';
  /** Optional model-family override for administrator-configured gateway aliases. */
  readonly speechModel?: FishSpeechModel;
  readonly url: string;
  readonly modelId: string;
  /** Omitted on update preserves the key; an empty string removes it. */
  readonly apiKey?: string;
  readonly voices: readonly TTSConnectionVoice[];
  readonly maxInputCharacters: number;
  readonly maxInputSegments: number;
  readonly paid: boolean;
  readonly enabled: boolean;
}

export type FishSpeechModel = 'fish-s2' | 'fish-drama';
export function fishSpeechModel(modelId?: string): FishSpeechModel | undefined {
  if (
    [
      's2-pro',
      's2.1-pro',
      's2.1-pro-free',
      'fish-audio/s2-pro',
      'fish-audio/s2.1-pro',
      'fish-audio/s2.1-pro-free:free',
    ].includes(modelId ?? '')
  )
    return 'fish-s2';
  if (modelId === 'drama-3' || modelId === 'fish-audio/drama-3') return 'fish-drama';
}
export function connectionSpeechModel(
  input: Pick<TTSConnectionInput, 'protocol' | 'speechModel' | 'modelId'>,
): FishSpeechModel | undefined {
  return input.protocol === 'local' ? undefined : (input.speechModel ?? fishSpeechModel(input.modelId));
}

export interface TTSConnection extends Omit<TTSConnectionInput, 'apiKey'> {
  readonly id: string;
  readonly hasApiKey: boolean;
  readonly revision: string;
}

export interface TTSConnectionDiscovery {
  readonly models: string[];
  readonly voices: TTSConnectionVoice[];
}

export interface TTSConnectionsPort {
  list(signal?: AbortSignal): Promise<TTSConnection[]>;
  probe(input: TTSConnectionInput, signal?: AbortSignal, id?: string): Promise<TTSConnectionDiscovery>;
  save(input: TTSConnectionInput, signal?: AbortSignal, id?: string): Promise<TTSConnection>;
  remove(id: string, signal?: AbortSignal): Promise<void>;
}
