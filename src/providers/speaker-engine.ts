/** Optional analysis service. Model credentials are held by BOAA, never by the browser or analysis engine. */
export interface SpeakerEngineInput {
  purpose?: 'analysis' | 'casting';
  name: string;
  engineUrl: string;
  engineToken?: string;
  protocol: 'openai' | 'gemini' | 'vertex';
  url: string;
  apiKey?: string;
  /** Vertex credentials are write-only, encrypted with the connection. Omitted keeps the saved key. */
  serviceAccountJson?: string;
  projectId?: string;
  location?: string;
  modelId: string;
  maxOutputTokens: number;
  tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
  reasoning?: 'low' | 'medium' | 'high';
  paid: boolean;
  enabled: boolean;
}
export interface SpeakerEngine extends Omit<SpeakerEngineInput, 'apiKey' | 'engineToken' | 'serviceAccountJson'> {
  id: string;
  hasApiKey: boolean;
  hasEngineToken: boolean;
  hasServiceAccount?: boolean;
  revision: string;
}
export interface SpeakerEngineDiscovery {
  engineVersion: string;
  models: string[];
}
export interface SpeakerEnginesPort {
  list(signal?: AbortSignal): Promise<SpeakerEngine[]>;
  probe(input: SpeakerEngineInput, signal?: AbortSignal, id?: string): Promise<SpeakerEngineDiscovery>;
  save(input: SpeakerEngineInput, signal?: AbortSignal, id?: string): Promise<SpeakerEngine>;
  remove(id: string, signal?: AbortSignal): Promise<void>;
}
