import { describe, expect, it, vi } from 'vitest';
import { GeminiTTSProvider } from './gemini-tts-provider';
import { wavFromPcm16 } from './tts-audio';

const input = () => ({
  alias: '합성 목소리',
  prompt: '차분하고 또렷한 원래 인물의 목소리',
  language: 'ko-KR',
  modelId: 'selected-design-model',
  signal: new AbortController().signal,
});
const wav = wavFromPcm16(Buffer.from([0, 0, 1, 0]), 24000);
const provider = (fetchImpl: typeof fetch) =>
  new GeminiTTSProvider({
    apiKey: 'fixture-key',
    baseUrl: 'http://gemini.invalid/',
    modelId: 'different-synthesis-model',
    fetchImpl,
  });

describe('Gemini stored voice design transport', () => {
  it('reuses the provider-created custom ID in actual synthesis speech_config instead of a preset or invented ID', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'voice_saved_custom' }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          outputs: [{ type: 'audio', mime_type: 'audio/pcm', data: Buffer.from([0, 0, 1, 0]).toString('base64') }],
        }),
      );
    const adapter = provider(fetchImpl);
    const designed = await adapter.designVoice(input());
    const audio = await adapter.synthesize({
      text: '합성 문장.',
      voiceProfile: {
        id: 'profile',
        novelId: 'book',
        role: 'character',
        providerId: 'gemini-tts',
        providerVoiceId: designed.id,
        label: '저장한 목소리',
        speed: 1,
        isUserSelected: true,
      },
    });
    expect(audio.contentType).toBe('audio/wav');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const synthesis = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(synthesis.model).toBe('different-synthesis-model');
    expect(synthesis.generation_config.speech_config).toEqual([{ voice: 'voice_saved_custom' }]);
  });
  it('creates a stored prompted voice with the selected model and returns the provider ID and sample', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'voice_provider_created',
        sample_audio: { mime_type: 'audio/wav', data: wav.toString('base64') },
      }),
    );
    const request = input();
    const result = await provider(fetchImpl).designVoice(request);
    expect(result).toEqual({ id: 'voice_provider_created', sample: { data: wav, contentType: 'audio/wav' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://gemini.invalid/v1beta/voices');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: request.signal });
    expect(new Headers(options?.headers).get('x-goog-api-key')).toBe('fixture-key');
    expect(JSON.parse(String(options?.body))).toEqual({
      store: true,
      voice: {
        type: 'prompted',
        model: 'selected-design-model',
        display_name: request.alias,
        language_code: 'ko-KR',
        prompted: { input: request.prompt },
      },
    });
  });

  it('allows a provider-created voice without a sample and omits unspecified language', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: 'voice_provider_created' }));
    expect(await provider(fetchImpl).designVoice({ ...input(), language: '' })).toEqual({
      id: 'voice_provider_created',
      sample: undefined,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).voice).not.toHaveProperty('language_code');
  });

  it('preserves HTTP 429 and Retry-After without retaining provider error text or retrying a paid creation', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('private-upstream-source', { status: 429, headers: { 'Retry-After': '23' } }),
    );
    const error = await provider(fetchImpl)
      .designVoice(input())
      .catch((e) => e as Error & { status: number; retryAfterSeconds: number });
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 23 });
    expect(String(error)).not.toContain('private-upstream-source');
    expect(String(error)).not.toContain('fixture-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or fabricated IDs, malformed samples and samples over the byte limit', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    const invalid = [
      null,
      {},
      { id: 'Kore' },
      { id: 'gemini:voice_foreign' },
      { id: 'voice_ok', sample_audio: { mime_type: 'audio/wav', data: 'not-base64?' } },
      { id: 'voice_ok', sample_audio: { mime_type: 'text/html', data: 'AQI=' } },
      { id: 'voice_ok', sample_audio: { mime_type: 'audio/wav', data: Buffer.from('not-wav').toString('base64') } },
      { id: 'voice_ok', sample_audio: { mime_type: 'audio/mpeg', data: '' } },
      { id: 'voice_ok', sample_audio: { mime_type: 'audio/mpeg', data: oversized } },
    ];
    for (const response of invalid) {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(response));
      await expect(provider(fetchImpl).designVoice(input())).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels an over-budget response stream and never dispatches without a key', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream));
    await expect(provider(fetchImpl).designVoice(input())).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledTimes(1);
    const noKey = new GeminiTTSProvider({ modelId: 'selected-model', fetchImpl });
    await expect(noKey.designVoice(input())).rejects.toThrow('API key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
