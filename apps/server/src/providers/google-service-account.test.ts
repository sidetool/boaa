import crypto from 'node:crypto';
import Fastify from 'fastify';
import { registerProviderIntegrationRoutes } from '../routes/ai/provider-integration-routes.js';
import type { VoiceProfile } from '@boaa/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import { parseGoogleServiceAccount } from './google-service-account.js';
import {
  saveProviderSecret,
  resolveProviderSecrets,
  deleteProviderSecret,
  providerSecretStatusBundle,
  type ProviderSecretRow,
} from './server-provider-secrets.js';
import { listServerProviderCatalog } from './server-provider-catalog.js';
import { createServerTTSSynthesisProvider } from './server-tts-provider-factory.js';
import { createGeminiVertexTTSGenerateContentClient } from './gemini-vertex-tts-provider.js';
import { wavFromPcm16 } from './tts-audio.js';

const sdk = vi.hoisted(() => ({ constructors: [] as Record<string, unknown>[], generate: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: sdk.generate };
    constructor(options: Record<string, unknown>) {
      sdk.constructors.push(options);
    }
  },
}));
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account',
  project_id: 'fixture-project',
  client_email: 'tts@fixture-project.iam.gserviceaccount.com',
  private_key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token',
};
const env = { PROVIDER_SECRET_ENCRYPTION_KEY: 'fixture-encryption-key' };
const config = { defaultUserId: 'fixture-owner' } as ServerConfig;
const voiceProfile: VoiceProfile = {
  novelId: 'fixture-book',
  role: 'character',
  label: 'Kore',
  speed: 1,
  isUserSelected: true,
  id: 'fixture-voice',
  providerId: 'gemini-vertex-tts',
  providerVoiceId: 'Kore',
  language: 'ko-KR',
};

function database() {
  let rows: ProviderSecretRow[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('insert into provider_secrets')) {
      const row = {
        scope: params[2],
        provider_id: params[3],
        secret_name: params[4],
        ciphertext: params[5],
        iv: params[6],
        auth_tag: params[7],
        key_version: params[8],
        fingerprint: params[9],
        last4: params[10],
        updated_at: '2026-10-18T00:00:00Z',
      } as ProviderSecretRow;
      rows = [
        ...rows.filter(
          (r) => r.scope !== row.scope || r.provider_id !== row.provider_id || r.secret_name !== row.secret_name,
        ),
        row,
      ];
      return { rows: [row] };
    }
    const matches = (r: ProviderSecretRow) =>
      r.scope === params[1] && r.provider_id === params[2] && r.secret_name === params[3];
    if (sql.includes('delete from provider_secrets')) {
      rows = rows.filter((r) => !matches(r));
      return { rows: [] };
    }
    return { rows: params.length === 4 ? rows.filter(matches) : rows };
  });
  return { pool: { query } as unknown as pg.Pool, rows: () => rows };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sdk.constructors.length = 0;
});

describe('Google service-account connection', () => {
  it('accepts RSA service-account keys and drops SDK endpoint/executable configuration', () => {
    expect(
      parseGoogleServiceAccount(
        JSON.stringify({
          ...account,
          credential_source: { executable: { command: 'bad' } },
          token_url: 'https://bad.invalid',
        }),
      ),
    ).toEqual(account);
  });
  it.each([
    { type: 'external_account' },
    { token_uri: 'http://127.0.0.1/token' },
    { universe_domain: 'attacker.invalid' },
    { private_key: 'not a key' },
    { client_email: 'not-google@example.com' },
    { project_id: '../bad' },
  ])('rejects invalid credentials without echoing secret values: %j', (override) => {
    expect(() => parseGoogleServiceAccount(JSON.stringify({ ...account, ...override }))).toThrow(
      'A valid Google service account JSON key is required',
    );
  });
  it('rejects malformed and oversized JSON', () => {
    expect(() => parseGoogleServiceAccount('{')).toThrow();
    expect(() => parseGoogleServiceAccount(JSON.stringify({ ...account, padding: 'x'.repeat(65536) }))).toThrow();
  });
  it.each(['gemini-vertex-tts', 'google-cloud-tts'])(
    'encrypts JSON, hides hints, selects it over legacy credentials and restores legacy on delete (%s)',
    async (providerId) => {
      const db = database();
      const scope = 'tts_synthesis';
      const secretName = 'service_account_json';
      const legacyName = providerId === 'gemini-vertex-tts' ? 'credential_path' : 'access_token';
      const legacyValue = providerId === 'gemini-vertex-tts' ? '/old/key.json' : 'old-access-token';
      await saveProviderSecret(
        db.pool,
        config,
        { scope, providerId, secretName: legacyName, secretValue: legacyValue },
        env,
      );
      const status = await saveProviderSecret(
        db.pool,
        config,
        { scope, providerId, secretName, secretValue: JSON.stringify(account) },
        env,
      );
      expect(status.last4).toBeUndefined();
      expect(status.fingerprint).toBeUndefined();
      expect(JSON.stringify(db.rows())).not.toContain('BEGIN PRIVATE KEY');
      const bundle = await providerSecretStatusBundle(db.pool, config, listServerProviderCatalog({}), env);
      expect(bundle.catalog.ttsProviders.find((p) => p.providerId === providerId)?.secretStatus).toEqual(status);
      expect(JSON.stringify(bundle)).not.toContain(account.client_email);
      expect(await resolveProviderSecrets(db.pool, config, scope, providerId, env)).toEqual({
        serviceAccount: account,
      });
      await deleteProviderSecret(db.pool, config, scope, providerId, secretName);
      expect(await resolveProviderSecrets(db.pool, config, scope, providerId, env)).toEqual(
        providerId === 'gemini-vertex-tts' ? { credentialsPath: legacyValue } : { accessToken: legacyValue },
      );
    },
  );
  it('advertises JSON capability only for the two hosted Google TTS providers', async () => {
    const db = database();
    const bundle = await providerSecretStatusBundle(db.pool, config, listServerProviderCatalog({}), env);
    expect(
      bundle.secretStatuses
        .filter((s) => s.secretName === 'service_account_json')
        .map((s) => [s.providerId, s.configured]),
    ).toEqual([
      ['gemini-vertex-tts', false],
      ['google-cloud-tts', false],
    ]);
    await expect(
      saveProviderSecret(
        db.pool,
        config,
        {
          scope: 'llm_labeling',
          providerId: 'gemini-vertex',
          secretName: 'service_account_json',
          secretValue: JSON.stringify(account),
        },
        env,
      ),
    ).rejects.toThrow('not supported');
  });
  it('accepts JSON through the existing secret HTTP endpoint and never returns the key', async () => {
    vi.stubEnv('PROVIDER_SECRET_ENCRYPTION_KEY', env.PROVIDER_SECRET_ENCRYPTION_KEY);
    const db = database();
    const app = Fastify();
    await registerProviderIntegrationRoutes(app, db.pool, config);
    try {
      const url = '/api/provider-secrets/tts_synthesis/gemini-vertex-tts/service_account_json';
      const rejected = await app.inject({
        method: 'PUT',
        url,
        payload: { secretValue: JSON.stringify({ ...account, type: 'external_account' }) },
      });
      expect(rejected.statusCode).toBe(400);
      expect(db.rows()).toHaveLength(0);
      const saved = await app.inject({ method: 'PUT', url, payload: { secretValue: JSON.stringify(account) } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().status).toMatchObject({ secretName: 'service_account_json', configured: true });
      expect(saved.body).not.toContain('PRIVATE KEY');
      expect(saved.body).not.toContain(account.client_email);
      const removed = await app.inject({ method: 'DELETE', url });
      expect(removed.statusCode).toBe(200);
      expect(db.rows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
  it('uses per-client credentials and JSON project, sends 3.8 style outside text, preserves WAV', async () => {
    const priorPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const wav = wavFromPcm16(Buffer.from([1, 0, 2, 0]), 24000);
    sdk.generate.mockResolvedValue({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { data: wav.toString('base64'), mimeType: 'audio/wav' } }] },
        },
      ],
    });
    const provider = createServerTTSSynthesisProvider({
      providerId: 'gemini-vertex-tts',
      env: { GOOGLE_CLOUD_PROJECT: 'old-project' },
      secrets: { serviceAccount: parseGoogleServiceAccount(JSON.stringify(account)) },
      providerOptions: { location: 'global', prompt: 'Read calmly' },
    });
    const result = await provider.synthesize({ text: '본문만 읽기', voiceProfile });
    expect(sdk.constructors[0]).toMatchObject({
      project: account.project_id,
      googleAuthOptions: { credentials: account },
    });
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(priorPath);
    expect(sdk.generate.mock.calls[0][0]).toMatchObject({
      model: 'gemini-3.8-flash-lite-tts',
      contents: '본문만 읽기',
      config: {
        httpOptions: {
          extraBody: {
            contents: [{ role: 'user', parts: [{ text: '본문만 읽기', speechMetadata: { style: 'Read calmly' } }] }],
            generationConfig: { speechConfig: { voiceConfig: { voice: 'Kore' } } },
          },
        },
      },
    });
    expect(Buffer.from(result.audio)).toEqual(wav);
    await createGeminiVertexTTSGenerateContentClient({
      project: 'legacy-project',
      location: 'global',
      credentialsPath: '/legacy/key.json',
    });
    expect(sdk.constructors[1]).toMatchObject({ googleAuthOptions: { keyFilename: '/legacy/key.json' } });
    expect(sdk.constructors[1].googleAuthOptions).not.toHaveProperty('credentials');
  });
  it('keeps 3.8 speech metadata on the wire through the installed Google SDK', async () => {
    const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
    type AuthOptions = NonNullable<import('@google/genai').GoogleGenAIOptions['googleAuthOptions']>;
    const fakeAuth = {
      getRequestHeaders: async () => new Headers({ Authorization: 'Bearer fixture-token' }),
    } as unknown as AuthOptions['authClient'];
    const client = new actual.GoogleGenAI({
      vertexai: true,
      project: 'fixture-project',
      location: 'global',
      googleAuthOptions: { authClient: fakeAuth },
    });
    const wav = wavFromPcm16(Buffer.from([1, 0]), 24000);
    const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('aiplatform.googleapis.com');
      const body = JSON.parse(String(init?.body));
      expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '본문', speechMetadata: { style: 'calm' } }] }]);
      expect(body.generationConfig.speechConfig).toEqual({ voiceConfig: { voice: 'Kore' } });
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const wrapper = await createGeminiVertexTTSGenerateContentClient({
      project: 'fixture-project',
      location: 'global',
    });
    sdk.generate.mockResolvedValue({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] },
        },
      ],
    });
    await wrapper.generateAudio({
      modelId: 'gemini-3.8-flash-lite-tts',
      contents: '본문',
      style: 'calm',
      voice: 'Kore',
      languageCode: 'ko-KR',
    });
    await client.models.generateContent(sdk.generate.mock.calls[0][0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('signs Google Cloud JWT using uploaded JSON instead of an old env token', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        expect(init?.redirect).toBe('error');
        const jwt = new URLSearchParams(String(init?.body)).get('assertion')!;
        const [header, payload, signature] = jwt.split('.');
        expect(
          crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${header}.${payload}`),
            key.publicKey,
            Buffer.from(signature, 'base64url'),
          ),
        ).toBe(true);
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
          iss: account.client_email,
          aud: 'https://oauth2.googleapis.com/token',
        });
        return Response.json({ access_token: 'fixture-new-token' });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-new-token');
      expect(new Headers(init?.headers).get('x-goog-user-project')).toBe(account.project_id);
      return Response.json({ audioContent: Buffer.from('fixture-audio').toString('base64') });
    });
    const provider = createServerTTSSynthesisProvider({
      providerId: 'google-cloud-tts',
      env: { TTS_GOOGLE_CLOUD_ACCESS_TOKEN: 'old-token', GOOGLE_CLOUD_PROJECT: 'old-project' },
      secrets: { serviceAccount: parseGoogleServiceAccount(JSON.stringify(account)) },
      fetchImpl,
    });
    await provider.synthesize({ text: '본문', voiceProfile });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
