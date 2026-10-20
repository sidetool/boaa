import { interactionAudioResponse } from './gemini-audio-response.js';
import { wavFromPcm16 } from './tts-audio.js';
import { GEMINI_VOICES, namedVoices } from './tts-voices.js';
import type { TTSSynthesisInput, TTSSynthesisProvider, TTSSynthesisResult } from '../../../../src/providers/tts';

export interface GeminiTTSProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fetchImpl?: typeof fetch;
}

export class GeminiTTSProvider implements TTSSynthesisProvider {
  readonly providerId = 'gemini-tts';
  readonly displayName = 'Gemini TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GeminiTTSProviderOptions) {}

  async listVoices() {
    return namedVoices(GEMINI_VOICES);
  }

  async synthesize(input: TTSSynthesisInput): Promise<TTSSynthesisResult> {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required for gemini-tts provider');
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const providerOptions = mergeOptions(
      this.options.providerOptions,
      input.voiceProfile.providerOptions,
      input.providerOptions,
    );
    const voice = stringOption(providerOptions, 'voice') ?? input.voiceProfile.providerVoiceId ?? 'Kore';
    const sampleRate = integerOption(providerOptions, 'sampleRate') ?? 24_000;
    const model = this.options.modelId || 'gemini-3.8-flash-lite-tts';
    const verbatim = model.startsWith('gemini-3.8-');
    const direction =
      stringOption(providerOptions, 'prompt') ??
      stringOption(providerOptions, 'instructions') ??
      speechInstructions(input);
    const style = [
      direction,
      input.speed !== undefined && input.speed !== 1
        ? `Speak at ${input.speed} times the normal reading speed.`
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    const response = await fetchImpl(
      `${this.options.baseUrl?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com'}/v1beta/interactions`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: verbatim
            ? [
                {
                  type: 'user_input',
                  content: [
                    {
                      type: 'text',
                      text: input.text,
                      ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}),
                    },
                  ],
                },
              ]
            : ttsInputText(input, providerOptions),
          response_format: verbatim
            ? { type: 'audio', mime_type: 'audio/l16', sample_rate: sampleRate }
            : { type: 'audio' },
          generation_config: {
            speech_config: [{ voice }],
          },
        }),
        signal: input.signal,
      },
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Gemini TTS request failed with ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const json = await response.json().catch(() => undefined);
    const { buffer: pcm } = interactionAudioResponse(json);
    if (!pcm.byteLength) throw new Error('Gemini TTS returned no audio data');
    const isWav = pcm.toString('ascii', 0, 4) === 'RIFF' && pcm.toString('ascii', 8, 12) === 'WAVE';
    const wav = isWav ? pcm : wavFromPcm16(pcm, sampleRate);
    return {
      audio: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
      contentType: 'audio/wav',
      providerRequestId: response.headers.get('x-request-id') ?? undefined,
      providerMetadata: {
        sourceContentType: isWav ? 'audio/wav' : 'audio/pcm',
        sampleRate,
        voice,
      },
    };
  }
}

function mergeOptions(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...values.filter(Boolean));
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integerOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function ttsInputText(input: TTSSynthesisInput, providerOptions: Record<string, unknown>): string {
  const prompt =
    stringOption(providerOptions, 'prompt') ??
    stringOption(providerOptions, 'instructions') ??
    speechInstructions(input);
  return prompt ? `${prompt}\n\n${input.text}` : input.text;
}

function speechInstructions(input: TTSSynthesisInput): string | undefined {
  const parts = [input.tone, input.emotion && input.emotion !== 'neutral' ? input.emotion : undefined].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length ? `Read the following text exactly with this delivery: ${parts.join(', ')}.` : undefined;
}
