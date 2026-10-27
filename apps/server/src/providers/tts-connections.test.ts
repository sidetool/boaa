import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { TTSConnectionInput } from '../../../../src/providers/tts-connections';
import type { TTSSynthesisInput } from '../../../../src/providers/tts';
import { normalizeTTSConnection, ttsConnectionModelRevision } from './tts-connection-config.js';
import { discoverTTSConnection } from './tts-connections.js';
import { ConnectionTTSProvider, splitConnectionText, joinConnectionWav } from './tts-connection-provider.js';
import { wavFromPcm16 } from './tts-audio.js';
import { requestLocalEndpoint } from './local-endpoint-egress-policy.js';

const config: TTSConnectionInput = {
  name: 'Test server',
  protocol: 'openai',
  url: 'http://127.0.0.1:9011/v1/audio/speech',
  modelId: 'fixture-model',
  voices: [{ id: 'speaker', label: 'Speaker', lang: 'ko' }],
  maxInputCharacters: 1000,
  maxInputSegments: 8,
  paid: false,
  enabled: true,
};
describe('saved TTS connection configuration', () => {
  it('normalizes local and OpenAI-compatible endpoints and forbids credential URLs', () => {
    expect(normalizeTTSConnection({ ...config, url: 'https://tts.example/v1/' }).url).toBe(
      'https://tts.example/v1/audio/speech',
    );
    expect(normalizeTTSConnection({ ...config, url: 'https://tts.example' }).url).toBe(
      'https://tts.example/v1/audio/speech',
    );
    expect(normalizeTTSConnection({ ...config, protocol: 'local', url: 'http://192.168.0.5:9011' }).url).toBe(
      'http://192.168.0.5:9011/synthesize',
    );
    for (const url of [
      'file:///tmp/tts',
      'https://user:key@tts.example',
      'https://tts.example/?token=key',
      'https://tts.example/#x',
    ])
      expect(() => normalizeTTSConnection({ ...config, url })).toThrow();
    for (const maxInputCharacters of [0, 20001, NaN, 1.5])
      expect(() => normalizeTTSConnection({ ...config, maxInputCharacters })).toThrow();
    expect(() => normalizeTTSConnection({ ...config, voices: [] })).toThrow();
    expect(() => normalizeTTSConnection({ ...config, voices: [{ id: '가'.repeat(100), label: 'Long ID' }] })).toThrow();
    expect(normalizeTTSConnection({ ...config, modelId: '', voices: [] }, true).voices).toEqual([]);
  });
  it('pins synthesis identity independently of display names, credentials and catalog', () => {
    const revision = ttsConnectionModelRevision(config);
    expect(
      ttsConnectionModelRevision({
        ...config,
        name: 'Renamed',
        apiKey: 'rotated',
        voices: [...config.voices, { id: 'new', label: 'New' }],
        maxInputCharacters: 500,
      }),
    ).toBe(revision);
    for (const patch of [{ modelId: 'different' }, { url: 'http://127.0.0.1:9012/v1/audio/speech' }])
      expect(ttsConnectionModelRevision({ ...config, ...patch })).not.toBe(revision);
  });
});
describe('connection metadata discovery', () => {
  it('bounds actual socket responses and does not follow redirects with credentials', async () => {
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url!);
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/secret' });
        response.end();
      } else response.end('x'.repeat(1024));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture address');
      const origin = `http://127.0.0.1:${address.port}`;
      await expect(
        requestLocalEndpoint(
          origin + '/large',
          { method: 'GET', signal: AbortSignal.timeout(1000) },
          { maxResponseBytes: 16 },
        ),
      ).rejects.toThrow('size limit');
      const redirected = await requestLocalEndpoint(
        origin + '/redirect',
        { method: 'GET', headers: { Authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(1000) },
        {},
      );
      expect(redirected.status).toBe(302);
      expect(seen).toEqual(['/large', '/redirect']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('uses GET metadata with bearer auth, normalizes voices and does not synthesize', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
      return Response.json(
        String(url).endsWith('/models')
          ? { data: [{ id: 'model-1' }] }
          : { voices: [{ voice_id: 'voice-1', name: '음성', language: 'ko' }] },
      );
    });
    expect(
      await discoverTTSConnection({ ...config, apiKey: 'test-key' }, new AbortController().signal, { fetchImpl }),
    ).toEqual({ models: ['model-1'], voices: [{ id: 'voice-1', label: '음성', lang: 'ko' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('speech'))).toBe(true);
  });
  it('supports manual voices where discovery is absent, and rejects redirects/auth/metadata targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    expect(await discoverTTSConnection(config, new AbortController().signal, { fetchImpl })).toEqual({
      models: [],
      voices: [],
    });
    for (const status of [302, 401, 403, 429]) {
      fetchImpl.mockImplementation(async () => new Response(null, { status }));
      await expect(discoverTTSConnection(config, new AbortController().signal, { fetchImpl })).rejects.toThrow();
    }
    fetchImpl.mockClear();
    await expect(
      discoverTTSConnection({ ...config, url: 'http://169.254.169.254/synthesize' }, new AbortController().signal, {
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
describe('connection synthesis', () => {
  const input = {
    text: '첫 번째 문장. 두 번째 문장.',
    voiceProfile: { providerVoiceId: 'speaker', speed: 1 },
    speed: 1,
  } as TTSSynthesisInput;
  it('splits without dropping text or surrogate halves, sends sequential OpenAI TTS and joins PCM audio', async () => {
    const text = '문장😀 끝. 다음😀 문장입니다.';
    const parts = splitConnectionText(text, 7);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => Array.from(p).length <= 7)).toBe(true);
    const check = vi.fn(async () => {});
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return new Response(new Uint8Array(wavFromPcm16(Buffer.from([1, 0, 2, 0]), 24000)), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    });
    const provider = new ConnectionTTSProvider(
      'connection-fixture',
      { ...config, apiKey: 'test-key', maxInputCharacters: 7 },
      check,
      { fetchImpl },
    );
    const result = await provider.synthesize({ ...input, text });
    expect(calls.map((v) => v.input).join('')).toBe(text);
    expect(
      calls.every((v) => v.model === 'fixture-model' && v.voice === 'speaker' && v.response_format === 'wav'),
    ).toBe(true);
    const bytes = Buffer.from(result.audio);
    expect(bytes.readUInt32LE(40)).toBe(parts.length * 4);
    expect(check).toHaveBeenCalledTimes(parts.length * 2);
  });
  it('sends local DTO, keeps configured voices independent of remote discovery and fences revoked requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ modelId: 'fixture-model', text: input.text, voiceId: 'speaker', format: 'wav' });
      return new Response(new Uint8Array(wavFromPcm16(Buffer.from([1, 0]), 24000)), {
        headers: { 'Content-Type': 'audio/wav' },
      });
    });
    const check = vi.fn(async () => {});
    const provider = new ConnectionTTSProvider(
      'connection-fixture',
      { ...config, protocol: 'local', url: 'http://127.0.0.1:9011/synthesize' },
      check,
      { fetchImpl },
    );
    expect(await provider.listVoices()).toEqual(config.voices);
    expect(fetchImpl).not.toHaveBeenCalled();
    await provider.synthesize(input);
    check.mockRejectedValue(new Error('changed'));
    await expect(provider.synthesize(input)).rejects.toThrow('changed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    abort.abort();
    await expect(provider.synthesize({ ...input, signal: abort.signal })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not replay already generated split parts after a later part is rate limited', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array(wavFromPcm16(Buffer.from([1, 0]), 24000)), {
          headers: { 'Content-Type': 'audio/wav' },
        }),
      )
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    const provider = new ConnectionTTSProvider(
      'connection-fixture',
      { ...config, maxInputCharacters: 7 },
      async () => {},
      { fetchImpl },
    );
    await expect(provider.synthesize({ ...input, text: 'One sentence. Another sentence.' })).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects incompatible or truncated audio rather than concatenating corrupt containers', () => {
    expect(() => joinConnectionWav([Buffer.from('not audio')])).toThrow();
    expect(() =>
      joinConnectionWav([wavFromPcm16(Buffer.alloc(4), 24000), wavFromPcm16(Buffer.alloc(4), 16000)]),
    ).toThrow();
    expect(() => joinConnectionWav([wavFromPcm16(Buffer.alloc(4), 24000).subarray(0, 45)])).toThrow();
  });
});
