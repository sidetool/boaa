import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSpeakerEngine, speakerRevision, castingRevision } from './speaker-engine-config';
import { SpeakerEngineTransport } from './speaker-engine-transport';
import { SPEAKER_ENGINE_PROTOCOL } from '../../../../src/providers/speaker-engine-protocol';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account',
  project_id: 'fixture-project',
  client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
  private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const input = {
  protocol: 'vertex',
  name: 'Vertex fixture',
  serviceAccountJson: JSON.stringify(account),
  engineUrl: 'http://speaker-engine:8095',
  url: 'http://must-not-receive-secrets.invalid',
  modelId: 'selected-model',
  maxOutputTokens: 4096,
  reasoning: 'high',
  paid: true,
  enabled: true,
};
const config = normalizeSpeakerEngine(input);
const signal = () => new AbortController().signal;
const output = () =>
  Response.json({
    candidates: [
      { finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }, { text: '{"ok":true}' }] } },
    ],
  });
afterEach(() => vi.useRealTimers());
function network(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>((url, init) => Promise.resolve(handler(String(url), init!)));
  return {
    fetchImpl,
    t: new SpeakerEngineTransport(
      { fetchImpl, lookup: async () => [{ address: '192.168.1.10', family: 4 }] },
      'internal-only',
    ),
  };
}
const generate = (t: SpeakerEngineTransport, v = config, s = signal()) =>
  t.generateJson(v, { prompt: 'Neutral text', schema: { type: 'object' } }, s, 'Return JSON.');

describe('Vertex speaker connections', () => {
  it('normalizes official destinations and sanitizes JSON without changing revisions on key rotation', () => {
    expect(config).toMatchObject({
      projectId: 'fixture-project',
      location: 'global',
      url: 'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google',
    });
    expect(config).not.toHaveProperty('apiKey');
    expect(JSON.parse(config.serviceAccountJson!)).not.toHaveProperty('client_id');
    const renamed = normalizeSpeakerEngine({
      ...input,
      name: 'renamed',
      serviceAccountJson: JSON.stringify({
        ...account,
        client_email: 'another@fixture-project.iam.gserviceaccount.com',
      }),
    });
    expect(speakerRevision(renamed)).toBe(speakerRevision(config));
    expect(castingRevision(renamed)).toBe(castingRevision(config));
    for (const location of ['global', 'us-central1', 'europe-west4', 'us', 'eu']) {
      const c = normalizeSpeakerEngine({ ...input, location });
      expect(new URL(c.url).hostname).toMatch(/\.googleapis\.com$/);
    }
    expect(speakerRevision(normalizeSpeakerEngine({ ...input, location: 'us-central1' }))).not.toBe(
      speakerRevision(config),
    );
    for (const change of [
      { projectId: 'x/../../evil' },
      { location: 'evil.test/path' },
      { serviceAccountJson: JSON.stringify({ ...account, token_uri: 'https://evil.test' }) },
      { serviceAccountJson: JSON.stringify({ type: 'external_account' }) },
      { serviceAccountJson: ' '.repeat(65537) },
    ])
      expect(() => normalizeSpeakerEngine({ ...input, ...change })).toThrow();
  });
  it('signs OAuth assertions and sends chosen model, reasoning and JSON generation only to Vertex', async () => {
    const { t, fetchImpl } = network((url, init) => {
      if (url.includes('oauth2.googleapis.com')) {
        const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
        const [header, claims, sig] = assertion.split('.');
        expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
          iss: account.client_email,
          aud: 'https://oauth2.googleapis.com/token',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        });
        expect(
          verify('RSA-SHA256', Buffer.from(header + '.' + claims), keys.publicKey, Buffer.from(sig!, 'base64url')),
        ).toBe(true);
        expect(new Headers(init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
        return Response.json({ access_token: 'oauth-token', expires_in: 3600 });
      }
      if (url.endsWith('/v1/capabilities')) {
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer internal-only');
        return Response.json({ protocol: SPEAKER_ENGINE_PROTOCOL, engineVersion: 'v' });
      }
      expect(url).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/us-central1/publishers/google/models/selected-model:generateContent',
      );
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer oauth-token');
      expect(JSON.parse(String(init.body))).toMatchObject({
        generationConfig: {
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'high' },
        },
      });
      expect(String(init.body)).not.toContain('PRIVATE KEY');
      return output();
    });
    expect(await generate(t, normalizeSpeakerEngine({ ...input, location: 'us-central1' }))).toBe('{"ok":true}');
    await t.capabilities(config, signal());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('sends PDF input through Vertex with OAuth and without a duplicate source-text part', async () => {
    const { t, fetchImpl } = network((url, init) => {
      if (url.includes('oauth2.')) return Response.json({ access_token: 'pdf-token', expires_in: 3600 });
      expect(url).toContain('/projects/fixture-project/locations/global/publishers/google/models/');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer pdf-token');
      const parts = JSON.parse(String(init.body)).contents[0].parts;
      expect(parts[0].inlineData.mimeType).toBe('application/pdf');
      expect(Buffer.from(parts[0].inlineData.data, 'base64').subarray(0, 8).toString()).toBe('%PDF-1.7');
      expect(JSON.stringify(parts)).not.toContain('Neutral text');
      return output();
    });
    expect(await generate(t, { ...config, purpose: 'casting', inputFormat: 'pdf' })).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('reads bounded official model pages and retains direct model IDs without a hardcoded list', async () => {
    let pages = 0;
    const { t } = network((url, init) => {
      if (url.includes('oauth2.')) return Response.json({ access_token: 'token', expires_in: 3600 });
      expect(url).toContain('https://aiplatform.googleapis.com/v1beta1/publishers/google/models?');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token');
      pages++;
      return Response.json({
        publisherModels: [
          { name: 'publishers/google/models/model-' + pages },
          { name: 'publishers/other/models/reject' },
        ],
        nextPageToken: 'bounded-next',
      });
    });
    expect(await t.models(config, signal())).toEqual(['model-1', 'model-2', 'model-3']);
    expect(pages).toBe(3);
  });
  it('reuses tokens until their refresh margin and isolates rotated credentials', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let tokens = 0;
    const { t } = network((url) =>
      url.includes('oauth2.')
        ? (tokens++, Response.json({ access_token: 'token-' + tokens, expires_in: 80 }))
        : output(),
    );
    await generate(t);
    await generate(t);
    expect(tokens).toBe(1);
    vi.setSystemTime(Date.now() + 21000);
    await generate(t);
    expect(tokens).toBe(2);
    await generate(
      t,
      normalizeSpeakerEngine({
        ...input,
        serviceAccountJson: JSON.stringify({
          ...account,
          client_email: 'rotated@fixture-project.iam.gserviceaccount.com',
        }),
      }),
    );
    expect(tokens).toBe(3);
  });
  it('preserves 429 retry metadata and hides upstream credential/error bodies', async () => {
    const { t } = network(
      () => new Response('private_key upstream-secret', { status: 429, headers: { 'Retry-After': '45' } }),
    );
    await expect(generate(t)).rejects.toMatchObject({ statusCode: 429, upstreamStatus: 429, retryAfterSeconds: 45 });
    await expect(generate(t)).rejects.not.toThrow('upstream-secret');
  });
  it('does not dispatch a pre-aborted call or cache a token returned after cancellation', async () => {
    const c = new AbortController();
    c.abort();
    let tokens = 0,
      cancel: AbortController | undefined;
    const { t, fetchImpl } = network((url) => {
      if (!url.includes('oauth2.')) return output();
      tokens++;
      cancel?.abort();
      return Response.json({ access_token: 'token', expires_in: 3600 });
    });
    await expect(generate(t, config, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    cancel = new AbortController();
    await expect(generate(t, config, cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
    cancel = undefined;
    await generate(t);
    expect(tokens).toBe(2);
  });
});
