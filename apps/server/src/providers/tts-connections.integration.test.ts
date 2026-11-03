import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness.js';
import { loadConfig } from '../config.js';
import { TTSConnectionStore } from './tts-connections.js';
import { registerTTSConnectionRoutes } from '../routes/ai/tts-connection-routes.js';
import { registerPlainTTSRoutes } from '../routes/ai/plain-tts-routes.js';
import { loadPlainTTSSources } from './plain-tts-sources.js';
import { wavFromPcm16 } from './tts-audio.js';
import type { TTSConnectionInput } from '../../../../src/providers/tts-connections';
import { voiceSourceModel } from '../services/voice-library-store';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
const input: TTSConnectionInput = {
  name: 'My GPU',
  protocol: 'openai',
  url: 'http://127.0.0.1:9011/v1',
  modelId: 'fixture-model',
  apiKey: 'test-only-private-key',
  voices: [{ id: 'test-voice', label: 'Test voice', lang: 'ko' }],
  maxInputCharacters: 1000,
  maxInputSegments: 8,
  paid: false,
  enabled: true,
};
async function setup(pool: pg.Pool) {
  await pool.query(`create table users(id text primary key); insert into users values('owner'),('other');`);
  await pool.query(await readFile(new URL('../db/migrations/0066_tts_connections.sql', import.meta.url), 'utf8'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'boaa-tts-connection-test-'));
  const config = loadConfig({ DEFAULT_USER_ID: 'owner', SERVER_DATA_DIR: dataDir });
  const env = { PROVIDER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ data: [{ id: 'fixture-model' }] });
    return new Response(new Uint8Array(wavFromPcm16(Buffer.alloc(8), 24000)), {
      headers: { 'content-type': 'audio/wav' },
    });
  });
  const store = new TTSConnectionStore(pool, config, env, { fetchImpl });
  return { store, config, env, fetchImpl, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}
(harness ? describe : describe.skip)('durable TTS connections', () => {
  it('persists Fish gateway capabilities through encryption, catalog and library model identity', async () => {
    await withPostgresSchema(harness!, 'tts_fish_capability', async (pool) => {
      const f = await setup(pool),
        app = Fastify();
      try {
        const saved = await f.store.save({ ...input, protocol: 'openrouter', modelId: 'fish-audio/drama-3' });
        const fresh = new TTSConnectionStore(pool, f.config, f.env, { fetchImpl: f.fetchImpl });
        const source = (await fresh.sources())[0];
        expect(source.performanceFormat).toBe('fish-drama');
        await registerPlainTTSRoutes(app, pool, f.config, { env: f.env, sources: () => fresh.sources() });
        const catalog = (await app.inject('/api/tts/plain/voices')).json();
        expect(catalog.voices[0]).toMatchObject({
          instructionsSupported: true,
          autoActingSupported: true,
          batchAudioSupported: true,
        });
        expect(catalog.voices[0].model).toEqual(voiceSourceModel(source));
        expect(f.fetchImpl).not.toHaveBeenCalled();
        const adapter = await source.createProvider();
        expect(adapter).not.toHaveProperty('designVoice');
        await adapter.synthesize({
          text: '안녕',
          voiceProfile: { providerVoiceId: 'test-voice' },
          providerOptions: { instructions: '차분하게' },
        } as never);
        expect(JSON.parse(String(f.fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
          model: 'fish-audio/drama-3',
          input: '[차분하게] 안녕',
        });
        await fresh.save({ ...input, protocol: 'openai', modelId: 'relay-alias', speechModel: 'fish-s2' }, saved.id);
        expect((await fresh.sources())[0].performanceFormat).toBe('fish-s2');
        await expect(
          adapter.synthesize({ text: '안녕', voiceProfile: { providerVoiceId: 'test-voice' } } as never),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
  it('encrypts endpoints and keys, survives a new instance, isolates owners and preserves keys only on the same origin', async () => {
    await withPostgresSchema(harness!, 'tts_connection_store', async (pool) => {
      const f = await setup(pool);
      try {
        const saved = await f.store.save(input);
        expect(JSON.stringify(saved)).not.toContain(input.apiKey);
        expect(saved).toMatchObject({ hasApiKey: true, url: input.url + '/audio/speech' });
        const raw = JSON.stringify((await pool.query('select * from tts_connections')).rows);
        expect(raw).not.toContain(input.apiKey);
        expect(raw).not.toContain('127.0.0.1');
        const fresh = new TTSConnectionStore(pool, f.config, f.env);
        expect(await fresh.list()).toEqual([saved]);
        const other = new TTSConnectionStore(pool, { ...f.config, defaultUserId: 'other' }, f.env);
        expect(await other.list()).toEqual([]);
        await expect(other.save(input, saved.id)).rejects.toMatchObject({ statusCode: 404 });
        await expect(other.remove(saved.id)).rejects.toMatchObject({ statusCode: 404 });
        const renamed = await f.store.save({ ...input, apiKey: undefined, name: 'Renamed' }, saved.id);
        expect(renamed).toMatchObject({ id: saved.id, hasApiKey: true });
        await expect(
          f.store.save({ ...input, apiKey: undefined, url: 'http://127.0.0.1:9012' }, saved.id),
        ).rejects.toThrow('API 키');
        const cleared = await f.store.save({ ...input, apiKey: '', url: 'http://127.0.0.1:9012' }, saved.id);
        expect(cleared.hasApiKey).toBe(false);
        await f.store.remove(saved.id);
        expect(await fresh.list()).toEqual([]);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('keeps model identity across a second connection and key rotation; invalidates on actual model change and disable/delete', async () => {
    await withPostgresSchema(harness!, 'tts_connection_identity', async (pool) => {
      const f = await setup(pool);
      try {
        const a = await f.store.save(input);
        const source = (await f.store.sources())[0],
          adapter = await source.createProvider();
        await f.store.save({ ...input, name: 'Other GPU' });
        expect((await f.store.sources())[0].synthesisRevision).toBe(source.synthesisRevision);
        await f.store.save({ ...input, apiKey: 'new-test-key', name: 'Renamed' }, a.id);
        const rotated = (await f.store.sources())[0];
        expect(rotated.synthesisRevision).toBe(source.synthesisRevision);
        await adapter.synthesize({ text: 'Test', voiceProfile: { providerVoiceId: 'test-voice' } } as never);
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        await f.store.save({ ...input, modelId: 'new-model' }, a.id);
        expect((await f.store.sources())[0].synthesisRevision).not.toBe(source.synthesisRevision);
        await expect(
          adapter.synthesize({ text: 'Test', voiceProfile: { providerVoiceId: 'test-voice' } } as never),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        await f.store.save({ ...input, enabled: false }, a.id);
        expect((await f.store.sources()).map((s) => s.id)).not.toContain(source.id);
        await f.store.remove(a.id);
        expect(await f.store.list()).toHaveLength(1);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('bounds concurrent additions transactionally without dropping existing connections', async () => {
    await withPostgresSchema(harness!, 'tts_connection_limit', async (pool) => {
      const f = await setup(pool);
      try {
        const result = await Promise.allSettled(
          Array.from({ length: 18 }, (_, i) => f.store.save({ ...input, name: `GPU ${i}` })),
        );
        expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(16);
        expect(result.filter((r) => r.status === 'rejected')).toHaveLength(2);
        expect(await f.store.list()).toHaveLength(16);
      } finally {
        await f.cleanup();
      }
    });
  });
  it('uses normal reader TTS and stable voice revision without changing defaults or provider settings', async () => {
    await withPostgresSchema(harness!, 'tts_connection_reader', async (pool) => {
      const f = await setup(pool),
        app = Fastify();
      try {
        await f.store.save(input);
        await registerPlainTTSRoutes(app, pool, f.config, { env: f.env, sources: () => f.store.sources() });
        const first = (await app.inject('/api/tts/plain/voices')).json();
        expect(first.defaultVoiceId).toBe('');
        expect(first.voices).toHaveLength(1);
        await f.store.save({ ...input, name: 'Another' });
        const request = {
          voiceId: first.voices[0].id,
          voiceRevision: first.voices[0].model.revision,
          modelRevision: first.revision,
          rate: 1,
        };
        const response = await app.inject({ method: 'POST', url: '/api/tts/plain/sample', payload: request });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('audio/wav');
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        const body = JSON.parse(String(f.fetchImpl.mock.calls[0][1]?.body));
        expect(body).toMatchObject({ model: 'fixture-model', voice: 'test-voice' });
        expect((await app.inject({ method: 'POST', url: '/api/tts/plain/sample', payload: request })).statusCode).toBe(
          200,
        );
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
        // The shared loader appends named connections independently of legacy provider settings.
        await pool.query(`create table provider_settings(scope text,default_provider_id text,enabled_provider_ids jsonb,model_overrides jsonb,provider_options jsonb,updated_at timestamptz,user_id text);
          create table provider_secrets(scope text,provider_id text,secret_name text,ciphertext text,iv text,auth_tag text,key_version text,fingerprint text,last4 text,updated_at timestamptz,user_id text);`);
        const before = (await pool.query('select * from provider_settings')).rows;
        expect(await loadPlainTTSSources(pool, f.config, f.env)).toHaveLength(2);
        expect((await pool.query('select * from provider_settings')).rows).toEqual(before);
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
  it('requires the bootstrap administrator for every connection operation and never returns secrets', async () => {
    await withPostgresSchema(harness!, 'tts_connection_routes', async (pool) => {
      const f = await setup(pool),
        app = Fastify();
      try {
        app.decorateRequest('principal', null);
        app.addHook('preHandler', async (req) => {
          const identity = req.headers['x-test-identity'];
          if (identity)
            req.principal = {
              userId: identity === 'other-admin' ? 'other' : 'owner',
              role: identity === 'member' ? 'member' : 'admin',
              authMethod: 'legacy-token',
            };
        });
        await registerTTSConnectionRoutes(app, pool, f.config, f.store);
        for (const identity of [undefined, 'member', 'other-admin']) {
          for (const [method, url] of [
            ['GET', '/api/tts/connections'],
            ['POST', '/api/tts/connections'],
            ['POST', '/api/tts/connections/probe'],
          ] as const) {
            const response = await app.inject({
              method,
              url,
              headers: identity ? { 'x-test-identity': identity } : {},
              ...(method === 'POST' ? { payload: input } : {}),
            });
            expect(response.statusCode).toBe(identity ? 403 : 401);
          }
        }
        const saved = await app.inject({
          method: 'POST',
          url: '/api/tts/connections',
          headers: { 'x-test-identity': 'owner' },
          payload: input,
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.body).not.toContain(input.apiKey);
        const list = await app.inject({
          method: 'GET',
          url: '/api/tts/connections',
          headers: { 'x-test-identity': 'owner' },
        });
        expect(list.json().connections).toHaveLength(1);
        expect(list.body).not.toContain(input.apiKey);
        expect(f.fetchImpl).not.toHaveBeenCalled();
      } finally {
        await app.close();
        await f.cleanup();
      }
    });
  });
});
