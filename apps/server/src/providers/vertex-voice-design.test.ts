import { describe, expect, it, vi } from 'vitest';
import { GeminiVertexTTSProvider } from './gemini-vertex-tts-provider';
import { GeminiTTSProvider } from './gemini-tts-provider';
const request = () => ({
  alias: '인물',
  prompt: '차분하고 낮은 성인 목소리',
  language: 'ko-KR',
  modelId: 'gemini-3.8-flash-tts',
  signal: new AbortController().signal,
});
const options = { project: 'fixture-project', location: 'global', modelId: 'gemini-3.8-flash-tts' };
describe('Vertex natural voice design', () => {
  it('stores a prompted voice without a model field, wraps PCM, and reuses its ID in synthesis', async () => {
    const pcm = Buffer.from([0, 0, 1, 0]);
    const designFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'voice_created',
        sample_audio: {
          mime_type: 'audio/l16; rate=24000; channels=1',
          data: pcm.toString('base64'),
        },
      }),
    );
    const generateAudio = vi.fn(async () => ({ audio: new ArrayBuffer(4) }));
    const adapter = new GeminiVertexTTSProvider({
      ...options,
      designFetch,
      designAccessToken: async () => 'fixture-token',
      client: { generateAudio },
    });
    const result = await adapter.designVoice(request());
    expect(result.sample?.data.subarray(0, 4).toString()).toBe('RIFF');
    expect(result.sample?.data.subarray(44)).toEqual(pcm);
    expect(designFetch).toHaveBeenCalledTimes(1);
    const [url, init] = designFetch.mock.calls[0];
    expect(url).toBe('https://aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/global/voices');
    expect(JSON.parse(String(init?.body))).toEqual({
      store: true,
      voice: {
        type: 'VOICE_TYPE_PROMPTED',
        displayName: '인물',
        languageCode: 'ko-KR',
        prompted: { input: request().prompt },
      },
    });
    await adapter.synthesize({
      text: '원문',
      voiceProfile: {
        id: 'p',
        novelId: 'book',
        role: 'character',
        providerId: adapter.providerId,
        providerVoiceId: result.id,
        label: '인물',
        speed: 1,
        isUserSelected: true,
      },
    });
    expect(generateAudio).toHaveBeenCalledWith(expect.objectContaining({ voice: 'voice_created', contents: '원문' }));
  });
  it('does not advertise or dispatch voice creation for other models, Lite, or regional Vertex', async () => {
    const designFetch = vi.fn<typeof fetch>();
    for (const modelId of ['gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts', 'other']) {
      const vertex = new GeminiVertexTTSProvider({ ...options, modelId, designFetch });
      const gemini = new GeminiTTSProvider({ apiKey: 'fixture', modelId, fetchImpl: designFetch });
      expect(vertex.supportsVoiceDesign).toBe(false);
      expect(gemini.supportsVoiceDesign).toBe(false);
      await expect(vertex.designVoice(request())).rejects.toThrow();
      await expect(gemini.designVoice(request())).rejects.toThrow();
    }
    const regional = new GeminiVertexTTSProvider({ ...options, location: 'us-central1', designFetch });
    expect(regional.supportsVoiceDesign).toBe(false);
    await expect(regional.designVoice(request())).rejects.toThrow();
    expect(designFetch).not.toHaveBeenCalled();
  });
  it('aborts authentication before dispatch and never retries uncertain or rate-limited requests', async () => {
    const designFetch = vi.fn<typeof fetch>();
    const abort = new AbortController();
    const auth = vi.fn(() => new Promise<string>(() => {}));
    const adapter = new GeminiVertexTTSProvider({ ...options, designFetch, designAccessToken: auth });
    const work = adapter.designVoice({ ...request(), signal: abort.signal });
    abort.abort();
    await expect(work).rejects.toThrow();
    expect(designFetch).not.toHaveBeenCalled();
    for (const status of [429, 503]) {
      designFetch.mockResolvedValueOnce(new Response('', { status }));
      const provider = new GeminiVertexTTSProvider({
        ...options,
        designFetch,
        designAccessToken: async () => 'fixture',
      });
      await expect(provider.designVoice(request())).rejects.toThrow();
    }
    expect(designFetch).toHaveBeenCalledTimes(2);
  });
  it('rejects invented IDs and malformed audio samples', async () => {
    for (const body of [
      { id: 'Kore' },
      { id: 'voice_valid', sampleAudio: { mimeType: 'audio/l16; rate=24000; channels=1', data: 'AA==' } },
    ]) {
      const provider = new GeminiVertexTTSProvider({
        ...options,
        designAccessToken: async () => 'fixture',
        designFetch: async () => Response.json(body),
      });
      await expect(provider.designVoice(request())).rejects.toThrow();
    }
  });
});
