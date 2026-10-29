import { isGeminiVoiceDesignModel } from '../../../../src/providers/voice-library';
import { googleTtsHttpError } from './tts-http-error.js';
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
  readonly supportsInstructions = true;
  readonly providerId = 'gemini-tts';
  readonly displayName = 'Gemini TTS';
  readonly supportsStreaming = true;
  readonly supportsAudioCache = true;
  readonly supportsPerCharacterVoice = true;

  constructor(private readonly options: GeminiTTSProviderOptions) {}

  get supportsVoiceDesign() {
    return isGeminiVoiceDesignModel(this.options.modelId);
  }

  async listVoices() {
    return namedVoices(GEMINI_VOICES);
  }

  async designVoice(input: { alias: string; prompt: string; language: string; modelId: string; signal: AbortSignal }) {
    if (!this.supportsVoiceDesign || !isGeminiVoiceDesignModel(input.modelId))
      throw new Error('Voice design requires Gemini 3.8 Flash TTS');
    const key = this.options.apiKey?.trim();
    if (!key) throw new Error('Gemini TTS API key is required');
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.baseUrl?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com'}/v1beta/voices`,
      {
        method: 'POST',
        signal: input.signal,
        redirect: 'error',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store: true,
          voice: {
            type: 'prompted',
            model: input.modelId,
            display_name: input.alias,
            ...(input.language ? { language_code: input.language } : {}),
            prompted: { input: input.prompt },
          },
        }),
      },
    );
    if (!response.ok) {
      throw await googleTtsHttpError(`Gemini voice design failed with ${response.status}`, response);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Gemini voice design returned no response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 6 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Gemini voice design response is too large');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('Gemini voice design returned invalid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Gemini voice design returned an invalid response');
    if (typeof value.id !== 'string' || !/^voice_[A-Za-z0-9_-]{1,240}$/.test(value.id))
      throw new Error('Gemini voice design returned an invalid voice ID');
    let sample;
    if (value.sample_audio) {
      const audio = value.sample_audio;
      if (
        typeof audio.data !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data) ||
        !['audio/wav', 'audio/mpeg'].includes(audio.mime_type)
      )
        throw new Error('Gemini voice design returned invalid sample audio');
      const data = Buffer.from(audio.data, 'base64');
      if (
        !data.length ||
        data.byteLength > 4 * 1024 * 1024 ||
        (audio.mime_type === 'audio/wav' &&
          (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'))
      )
        throw new Error('Gemini voice sample is invalid');
      sample = { data, contentType: audio.mime_type as string };
    }
    return { id: value.id as string, sample };
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
      // Preserve status for cooldown/retry without retaining provider text or credentials.
      throw await googleTtsHttpError(`Gemini TTS request failed with ${response.status}`, response);
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
