/** Administrator-managed TTS connections. Credentials never belong in browser storage. */
export interface TTSConnectionVoice {
  readonly id: string;
  readonly label: string;
  readonly lang?: string;
}

export interface TTSConnectionInput {
  readonly name: string;
  readonly protocol: 'local' | 'openai';
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
