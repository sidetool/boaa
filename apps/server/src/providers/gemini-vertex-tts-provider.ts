import { vertexAudioResponse } from './gemini-audio-response.js';
import type { GoogleServiceAccount } from './google-service-account.js';
import { GEMINI_VOICES, namedVoices } from './tts-voices.js';
import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface GeminiVertexTTSGenerateContentClient {
  generateAudio(input: {
    readonly modelId: string;
    readonly contents: string;
    readonly style?: string;
    readonly voice: string;
    readonly languageCode: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly audio: ArrayBuffer;
    readonly sourceContentType?: string;
    readonly providerRequestId?: string;
  }>;
}

export interface GeminiVertexTTSProviderOptions {
  readonly project?: string;
  readonly location: string;
  readonly credentialsPath?: string;
  readonly serviceAccount?: GoogleServiceAccount;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly client?: GeminiVertexTTSGenerateContentClient;
}

export class GeminiVertexTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'gemini-vertex-tts';
  readonly displayName = 'Gemini Vertex TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GeminiVertexTTSProviderOptions) {}

  async listVoices() {
    return namedVoices(GEMINI_VOICES);
  }

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    if (!this.options.modelId.trim()) throw new Error('Gemini Vertex TTS model id is required');
    const providerOptions = mergeOptions(
      this.options.providerOptions,
      input.voiceProfile.providerOptions,
      input.providerOptions,
    );
    const voice = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? 'Kore';
    const languageCode = stringOption(providerOptions, 'languageCode') ?? input.voiceProfile.language ?? 'ko-KR';
    const client = this.options.client ?? (await createGeminiVertexTTSGenerateContentClient(this.options));
    const result = await client.generateAudio({
      modelId: this.options.modelId,
      contents: this.options.modelId.startsWith('gemini-3.8-') ? input.text : ttsInputText(input, providerOptions),
      style:
        [
          stringOption(providerOptions, 'prompt') ??
            stringOption(providerOptions, 'instructions') ??
            speechInstructions(input),
          input.speed !== undefined && input.speed !== 1 ? `Speak at ${input.speed} times normal speed.` : undefined,
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      voice,
      languageCode,
      signal: input.signal,
    });
    if (!result.audio.byteLength) throw new Error('Gemini Vertex TTS returned no audio data');
    const audio = Buffer.from(result.audio);
    const isWav = audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
    const wav = isWav || result.sourceContentType?.startsWith('audio/wav') ? audio : wavFromPcm16(audio, 24_000);
    return {
      audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      contentType: 'audio/wav',
      providerRequestId: result.providerRequestId,
      providerMetadata: {
        sourceContentType: result.sourceContentType ?? 'audio/pcm',
        sampleRate: 24_000,
        voice,
        languageCode,
      },
    };
  }
}

export async function createGeminiVertexTTSGenerateContentClient(
  options: Omit<GeminiVertexTTSProviderOptions, 'client' | 'modelId'>,
): Promise<GeminiVertexTTSGenerateContentClient> {
  if (!options.project?.trim()) throw new Error('GOOGLE_CLOUD_PROJECT is required for gemini-vertex-tts provider');
  const { GoogleGenAI } = await import('@google/genai');
  const sdkClient = new GoogleGenAI({
    vertexai: true,
    project: options.project,
    location: options.location || 'global',
    googleAuthOptions: options.serviceAccount
      ? { credentials: { ...options.serviceAccount }, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }
      : options.credentialsPath
        ? { keyFilename: options.credentialsPath }
        : undefined,
  });
  return {
    async generateAudio(input) {
      const response = await sdkClient.models.generateContent({
        model: input.modelId,
        contents: input.contents,
        config: {
          responseModalities: ['AUDIO'],
          ...(!input.modelId.startsWith('gemini-3.8-')
            ? {
                speechConfig: {
                  languageCode: input.languageCode,
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: input.voice,
                    },
                  },
                },
              }
            : {
                httpOptions: {
                  extraBody: {
                    contents: [
                      {
                        role: 'user',
                        parts: [
                          { text: input.contents, ...(input.style ? { speechMetadata: { style: input.style } } : {}) },
                        ],
                      },
                    ],
                    generationConfig: { speechConfig: { voiceConfig: { voice: input.voice } } },
                  },
                },
              }),
          abortSignal: input.signal,
        } as Record<string, unknown>,
      });
      const audio = vertexAudioResponse(response);
      if (!audio.buffer.byteLength) throw new Error('Gemini Vertex TTS returned no audio data');
      const audioBuffer = audio.buffer;
      return {
        audio: audioBuffer.buffer.slice(
          audioBuffer.byteOffset,
          audioBuffer.byteOffset + audioBuffer.byteLength,
        ) as ArrayBuffer,
        sourceContentType: audio.mimeType,
        providerRequestId: response.sdkHttpResponse?.headers?.['x-request-id'],
      };
    },
  };
}

function mergeOptions(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values.filter(Boolean));
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ttsInputText(input: TTSSynthesisInput, providerOptions: Record<string, unknown>): string {
  const prompt =
    stringOption(providerOptions, 'prompt') ??
    stringOption(providerOptions, 'instructions') ??
    speechInstructions(input);
  return prompt ? `${prompt}: ${input.text}` : input.text;
}

function speechInstructions(input: TTSSynthesisInput): string | undefined {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? input.emotion : undefined].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length ? `Read the following text exactly with this delivery: ${parts.join(', ')}` : undefined;
}

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}
