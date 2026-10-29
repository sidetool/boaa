import { describe, expect, it, vi } from 'vitest';
import { SpeakerEngineTransport } from './speaker-engine-transport';
import { normalizeSpeakerEngine, speakerRevision, castingRevision } from './speaker-engine-config';
import { SPEAKER_ENGINE_PROTOCOL } from '../../../../src/providers/speaker-engine-protocol';
const config = normalizeSpeakerEngine({
  name: 'Fixture',
  engineUrl: 'http://engine.test',
  engineToken: 'engine-token',
  protocol: 'openai',
  url: 'https://model.test/v1',
  apiKey: 'model-token',
  modelId: 'chosen-model',
  maxOutputTokens: 4096,
  paid: false,
  enabled: true,
});
const request = {
  kind: 'request' as const,
  stage: 'attribution' as const,
  checkpoint: {},
  prompt: 'Neutral source',
  schema: { type: 'OBJECT' },
};
describe('speaker model transport', () => {
  it('accepts a chapter analysis taking over three minutes without dispatching again', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms);
      return c.signal;
    });
    try {
      const fetchImpl = vi.fn(
        (_url: unknown, init: RequestInit = {}) =>
          new Promise<Response>((resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
            setTimeout(
              () =>
                resolve(Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })),
              240_000,
            );
          }),
      );
      const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
      const result = t.generate(config, request, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(240_001);
      expect(await result).toBe('{"ok":true}');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
  it.each(['attribution', 'identity', 'cancel'] as const)(
    'bounds %s without retrying or reporting a TTS playback error',
    async (stage) => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return c.signal;
      });
      try {
        const fetchImpl = vi.fn(
          (_url: unknown, init: RequestInit = {}) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
            }),
        );
        const t = new SpeakerEngineTransport({
          fetchImpl,
          lookup: async () => [{ address: '192.168.1.10', family: 4 }],
        });
        const caller = new AbortController();
        const result = t.generate(
          config,
          { ...request, stage: stage === 'identity' ? 'identity' : 'attribution' },
          caller.signal,
        );
        const checked =
          stage === 'cancel'
            ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
            : expect(result).rejects.toMatchObject({
                statusCode: 504,
                message: expect.stringContaining(stage === 'identity' ? '인물 연결 분석' : '화자 찾기 분석'),
              });
        await vi.advanceTimersByTimeAsync(1);
        if (stage === 'cancel') caller.abort();
        else await vi.advanceTimersByTimeAsync(600_000);
        await checked;
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    },
  );
  it('uses the deployment token only for the exact default engine and lets explicit credentials override it', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ protocol: SPEAKER_ENGINE_PROTOCOL, engineVersion: 'v' }));
    const t = new SpeakerEngineTransport(
      { fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] },
      'managed-internal-token',
    );
    const signal = new AbortController().signal;
    const local = { ...config, engineUrl: 'http://speaker-engine:8095', engineToken: undefined };
    await t.capabilities(local, signal);
    await t.capabilities({ ...local, engineToken: 'explicit-token' }, signal);
    for (const engineUrl of [
      'http://other.test:8095',
      'http://speaker-engine:8095/path',
      'https://speaker-engine:8095',
    ])
      await t.capabilities({ ...local, engineUrl }, signal);
    await t.models({ ...local, apiKey: undefined }, signal);
    const headers = fetchImpl.mock.calls.map((call) => new Headers((call as unknown as [URL, RequestInit])[1].headers));
    expect(headers.map((h) => h.get('Authorization'))).toEqual([
      'Bearer managed-internal-token',
      'Bearer explicit-token',
      null,
      null,
      null,
      null,
    ]);
  });
  it('uses selected OpenAI-compatible model and explicit budget dialect without sending model keys to the engine', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }),
    );
    const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    expect(await t.generate(config, request, new AbortController().signal)).toBe('{"ok":true}');
    const first = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(first[1].body as string);
    expect(body).toMatchObject({ model: 'chosen-model', max_tokens: 4096, stream: false });
    expect(body).not.toHaveProperty('reasoning_effort');
    await t.generate(
      { ...config, tokenLimitParameter: 'max_completion_tokens', reasoning: 'high' },
      request,
      new AbortController().signal,
    );
    const second = JSON.parse((fetchImpl.mock.calls[1] as unknown as [URL, RequestInit])[1].body as string);
    expect(second.max_completion_tokens).toBe(4096);
    expect(second).not.toHaveProperty('max_tokens');
    fetchImpl.mockResolvedValueOnce(Response.json({ protocol: SPEAKER_ENGINE_PROTOCOL, engineVersion: 'version' }));
    await t.capabilities(config, new AbortController().signal);
    const third = fetchImpl.mock.calls[2] as unknown as [URL, RequestInit];
    expect(new Headers(third[1].headers).get('Authorization')).toBe('Bearer engine-token');
    expect(JSON.stringify(third)).not.toContain('model-token');
  });
  it('supports Gemini body and filters thought parts; rejects truncation, invalid responses and redirects', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ thought: true, text: 'private reasoning' }, { text: '{"ok":true}' }] },
          },
        ],
      }),
    );
    const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    const v = { ...config, protocol: 'gemini' as const, url: 'https://model.test/v1beta' };
    expect(await t.generate(v, request, new AbortController().signal)).toBe('{"ok":true}');
    const call = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(call[0])).toContain('/models/chosen-model:generateContent');
    expect(new Headers(call[1].headers).get('x-goog-api-key')).toBe('model-token');
    for (const response of [
      Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'truncated' }] } }] }),
      Response.json(null),
      new Response('', { status: 302, headers: { Location: 'https://other.test' } }),
    ]) {
      fetchImpl.mockResolvedValueOnce(response);
      await expect(t.generate(v, request, new AbortController().signal)).rejects.toMatchObject({ statusCode: 502 });
    }
  });
  it('keeps semantic revision stable across key/catalog/label changes and preserves bounded date Retry-After', async () => {
    expect(speakerRevision({ ...config, apiKey: 'new', name: 'renamed', paid: true })).toBe(speakerRevision(config));
    expect(speakerRevision({ ...config, modelId: 'other' })).not.toBe(speakerRevision(config));
    const fetchImpl = vi.fn(
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': new Date(Date.now() + 120000).toUTCString() } }),
    );
    const t = new SpeakerEngineTransport({ fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    await expect(t.generate(config, request, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSeconds: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('analysis execution settings', () => {
  it('preserves explicit zero and bounds while keeping execution choices outside semantic revisions', () => {
    expect(normalizeSpeakerEngine(config)).not.toHaveProperty('analysisConcurrency');
    expect(normalizeSpeakerEngine(config)).not.toHaveProperty('rateLimitRetries');
    for (const analysisConcurrency of [1, 8]) {
      for (const rateLimitRetries of [0, 100]) {
        const value = normalizeSpeakerEngine({ ...config, analysisConcurrency, rateLimitRetries });
        expect(value).toMatchObject({ analysisConcurrency, rateLimitRetries });
        expect(speakerRevision(value)).toBe(speakerRevision(config));
        expect(castingRevision(value)).toBe(castingRevision(config));
      }
    }
    for (const [key, invalid] of [
      ['analysisConcurrency', [0, 9, 1.5, '2', null]],
      ['rateLimitRetries', [-1, 101, 1.5, '0', null]],
    ] as const) {
      for (const value of invalid) expect(() => normalizeSpeakerEngine({ ...config, [key]: value })).toThrow();
    }
  });
});
