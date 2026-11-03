import { describe, expect, it, vi } from 'vitest';
import type { TTSConnectionInput } from '../../../../src/providers/tts-connections';
import type { TTSSynthesisInput } from '../../../../src/providers/tts';
import { fishDirection, fishLiteralText } from '../../../../src/providers/fish-performance';
import { NEUTRAL_PERFORMANCE, performanceStyle } from '../../../../src/providers/tts-performance';
import { normalizeTTSConnection, ttsConnectionModelRevision } from './tts-connection-config';
import { ConnectionTTSProvider } from './tts-connection-provider';
import { discoverTTSConnection } from './tts-connections';
import { wavFromPcm16 } from './tts-audio';

const config: TTSConnectionInput = {
  name: 'Fish',
  protocol: 'fish',
  url: 'http://127.0.0.1:9011/v1/tts',
  modelId: 's2.1-pro-free',
  apiKey: 'fixture-secret',
  voices: [{ id: 'voice', label: '목소리' }],
  maxInputCharacters: 1000,
  maxInputSegments: 8,
  paid: false,
  enabled: true,
};
const input = {
  text: '[괜찮아.] <속삭임>',
  voiceProfile: {
    id: 'v',
    novelId: 'b',
    role: 'narrator',
    providerId: 'connection-fixture',
    providerVoiceId: 'voice',
    label: '목소리',
    speed: 1,
    isUserSelected: true,
  },
  speed: 1.2,
  providerOptions: { instructions: '[slightly sad][normal conversational pace]' },
} as TTSSynthesisInput;
const pcm = () => new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'Content-Type': 'audio/pcm' } });
const provider = (fetchImpl: typeof fetch, patch: Partial<TTSConnectionInput> = {}) =>
  new ConnectionTTSProvider('connection-fixture', { ...config, ...patch }, async () => {}, { fetchImpl });

describe('Fish model and gateway boundary', () => {
  it('normalizes service endpoints, rejects native paid fallback and pins alias semantics', () => {
    expect(normalizeTTSConnection({ ...config, url: 'https://api.fish.audio' }).url).toBe(
      'https://api.fish.audio/v1/tts',
    );
    expect(normalizeTTSConnection({ ...config, protocol: 'openrouter', url: 'https://openrouter.ai' }).url).toBe(
      'https://openrouter.ai/api/v1/audio/speech',
    );
    expect(() => normalizeTTSConnection({ ...config, modelId: 's2.1-typo' })).toThrow();
    expect(() => normalizeTTSConnection({ ...config, speechModel: 'fish-drama' })).toThrow();
    const alias = { ...config, protocol: 'openai' as const, modelId: 'my-alias' };
    expect(ttsConnectionModelRevision({ ...alias, speechModel: 'fish-s2' })).not.toBe(
      ttsConnectionModelRevision(alias),
    );
    expect(ttsConnectionModelRevision({ ...config, speechModel: 'fish-s2' })).toBe(ttsConnectionModelRevision(config));
  });
  it.each(['s2.1-pro', 's2.1-pro-free', 'drama-3'])(
    'sends native %s as a header, protects source text and wraps PCM accurately',
    async (modelId) => {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.headers).toMatchObject({ model: modelId, Authorization: 'Bearer fixture-secret' });
        expect(JSON.parse(String(init?.body))).toEqual({
          text: '[slightly sad][normal conversational pace] ［괜찮아.］ ＜속삭임＞',
          reference_id: 'voice',
          format: 'pcm',
          sample_rate: 44100,
          prosody: { speed: 1.2 },
        });
        return pcm();
      });
      const result = await provider(fetchImpl, { modelId }).synthesize(input);
      const wav = Buffer.from(result.audio);
      expect(result.contentType).toBe('audio/wav');
      expect(wav.readUInt32LE(24)).toBe(44100);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
      expect(input.text).toBe('[괜찮아.] <속삭임>');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['fish-audio/s2.1-pro', 'fish-audio/s2.1-pro-free:free', 'fish-audio/drama-3'])(
    'uses OpenRouter speech, including exact free model %s, without duplicate directions',
    async (modelId) => {
      const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe('http://127.0.0.1:9011/api/v1/audio/speech');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          model: modelId,
          input: '[slightly sad][normal conversational pace] ［괜찮아.］ ＜속삭임＞',
          voice: 'voice',
          response_format: 'pcm',
          speed: 1.2,
          provider: { options: { 'fish-audio': { sample_rate: 44100 } } },
        });
        expect(init?.headers).not.toHaveProperty('model');
        return pcm();
      });
      await provider(fetchImpl, {
        protocol: 'openrouter',
        url: 'http://127.0.0.1:9011/api/v1/audio/speech',
        modelId,
      }).synthesize(input);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it('supports OpenAI-compatible aliases and reserves the direction budget for every split', async () => {
    const texts: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'custom-drama', voice: 'voice', response_format: 'wav' });
      expect(body.instructions).toBeUndefined();
      texts.push(body.input);
      return new Response(new Uint8Array(wavFromPcm16(Buffer.from([1, 0]), 44100)), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    });
    const p = provider(fetchImpl, {
      protocol: 'openai',
      modelId: 'custom-drama',
      speechModel: 'fish-drama',
      maxInputCharacters: 18,
    });
    expect(p.supportsInstructions).toBe(true);
    await p.synthesize({
      ...input,
      text: '안녕하세요. 다음 문장입니다.',
      providerOptions: { instructions: '낮게 말하기' },
    });
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => Array.from(t).length <= 18)).toBe(true);
    expect(texts.map((t) => t.replace('[낮게 말하기] ', '')).join('')).toBe('안녕하세요. 다음 문장입니다.');
    fetchImpl.mockClear();
    await expect(p.synthesize({ ...input, providerOptions: { instructions: '가'.repeat(30) } })).rejects.toThrow(
      '한도',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('retains quota timing, distinguishes explicit policy refusal and never retries itself', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    await expect(provider(fetchImpl).synthesize(input)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 120 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async () =>
      Response.json({ error: { code: 'content_policy_violation', message: 'fixture-secret' } }, { status: 400 }),
    );
    await expect(provider(fetchImpl).synthesize(input)).rejects.toMatchObject({ code: 'tts_content_blocked' });
    fetchImpl.mockClear();
    await expect(provider(fetchImpl).synthesize({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects JSON, truncated WAV and odd PCM responses', async () => {
    for (const response of [
      Response.json({ error: 'not audio' }),
      new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'audio/pcm' } }),
      new Response(new Uint8Array(wavFromPcm16(Buffer.alloc(4), 44100).subarray(0, 45)), {
        headers: { 'Content-Type': 'audio/wav' },
      }),
    ])
      await expect(provider(async () => response).synthesize(input)).rejects.toThrow();
  });
});

it('discovers Fish voice references and OpenRouter speech models using GET only', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Authorization: 'Bearer fixture-secret' });
    if (String(url).includes('/model?'))
      return Response.json({
        items: [
          { _id: 'v1', title: '목소리', type: 'tts', state: 'created', languages: ['ko'] },
          { _id: 'v2', type: 'svc' },
          { _id: 'removed', type: 'tts', dmca_taken_down: true },
        ],
      });
    expect(String(url)).toContain('/api/v1/models?output_modalities=speech');
    return Response.json({
      data: [
        { id: 'chat', architecture: { output_modalities: ['text'] } },
        { id: 'fish-audio/drama-3', architecture: { output_modalities: ['speech'] }, supported_voices: null },
      ],
    });
  });
  const native = await discoverTTSConnection(config, AbortSignal.timeout(1000), { fetchImpl });
  expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:9011/model?page_size=64');
  expect(native.voices).toEqual([{ id: 'v1', label: '목소리', lang: 'ko' }]);
  expect(native.models).toContain('s2.1-pro-free');
  expect(
    await discoverTTSConnection(
      {
        ...config,
        protocol: 'openrouter',
        modelId: 'fish-audio/drama-3',
        url: 'http://127.0.0.1:9011/api/v1/audio/speech',
      },
      AbortSignal.timeout(1000),
      { fetchImpl },
    ),
  ).toEqual({ models: ['fish-audio/drama-3'], voices: [] });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('renders restrained acting per Fish model without changing neutral or source text', () => {
  for (const format of ['fish-s2', 'fish-drama'] as const) {
    expect(performanceStyle(NEUTRAL_PERFORMANCE, format)).toBeUndefined();
    expect(performanceStyle({ ...NEUTRAL_PERFORMANCE, emotion: 'afraid' }, format)).toContain('slightly scared');
    expect(performanceStyle({ ...NEUTRAL_PERFORMANCE, emotion: 'sad' }, format)).toContain(
      'normal conversational pace',
    );
    expect(performanceStyle({ ...NEUTRAL_PERFORMANCE, delivery: 'crying' }, format)).toContain('restrained crying');
  }
  expect(performanceStyle({ ...NEUTRAL_PERFORMANCE, emotion: 'sad' }, 'fish-drama')).toBe(
    '[slightly sad, normal conversational pace]',
  );
  expect(fishDirection('차분하게 말하기')).toBe('[차분하게 말하기]');
  expect(fishDirection('[whispering]')).toBe('[whispering]');
  expect(fishLiteralText('<|speaker:1|>[happy]대사')).toBe('＜|speaker:1|＞［happy］대사');
});
