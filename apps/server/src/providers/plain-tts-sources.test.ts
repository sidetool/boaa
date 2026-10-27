import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { loadPlainTTSSources, preparedTTSConcurrency } from './plain-tts-sources.js';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';

function fixture() {
  const row = {
    scope: 'tts_synthesis',
    default_provider_id: 'gemini-tts',
    enabled_provider_ids: ['local-endpoint', 'gemini-tts'],
    model_overrides: {},
    provider_options: { 'gemini-tts': { voice: 'Kore' } },
    updated_at: '2026-10-18T00:00:00Z',
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      expect(params[0]).toBe('admin_fixture');
      if (sql.includes('from provider_settings')) return { rows: [row] };
      if (sql.includes('from provider_secrets')) return { rows: [] };
      if (sql.includes('from tts_connections')) return { rows: [] };
      throw new Error('unexpected query');
    }),
  } as unknown as pg.Pool;
  const env = {
    GEMINI_API_KEY: 'fixture-only-never-expose',
    TTS_LOCAL_ENDPOINT_URL: 'http://127.0.0.1:9010/synthesize',
    TTS_LOCAL_ENDPOINT_MODEL_ID: 'supertonic-3-ko',
    OPENAI_API_KEY: 'disabled-fixture-key',
  };
  const config = loadConfig({ DEFAULT_USER_ID: 'admin_fixture' });
  return { row, pool, env, config };
}

it('parallelizes known cloud preparation without changing model identity or assuming custom-server capacity', async () => {
  const f = fixture();
  const sources = await loadPlainTTSSources(f.pool, f.config, f.env);
  const cloud = { providerId: 'gemini-tts', revision: 'same' };
  const local = { providerId: 'local-endpoint', revision: 'same' };
  const input: AudiobookInput = {
    chapterIds: ['c1'],
    voiceId: 'v',
    modelRevision: 'catalog',
    chunking: 'paragraph',
    footnotePlayback: 'skip',
    rules: [],
    model: cloud,
  };
  expect(preparedTTSConcurrency(input, sources)).toBe(2);
  expect(preparedTTSConcurrency({ ...input, model: local }, sources)).toBe(1);
  expect(preparedTTSConcurrency({ ...input, model: undefined }, sources)).toBe(1);
  expect(
    preparedTTSConcurrency(
      input,
      sources.filter((s) => s.id !== cloud.providerId),
    ),
  ).toBe(1);
  expect(
    preparedTTSConcurrency(
      input,
      sources.map((s) => ({ ...s, paid: true, backgroundConcurrency: undefined })),
    ),
  ).toBe(1);
  const cast: NonNullable<AudiobookInput['cast']> = {
    engineId: 'fixture',
    engineRevision: 'v1',
    engineVersion: 'v1',
    characterVoiceIds: ['other'],
    models: { narrator: cloud, other: local },
  };
  expect(preparedTTSConcurrency({ ...input, cast }, sources)).toBe(1);
  expect(
    preparedTTSConcurrency({ ...input, cast: { ...cast, models: { narrator: cloud, other: cloud } } }, sources),
  ).toBe(2);
});

describe('ordinary TTS provider configuration', () => {
  it('uses owner settings, excludes disabled providers, and keeps credentials server-side', async () => {
    const f = fixture();
    const sources = await loadPlainTTSSources(f.pool, f.config, f.env);
    expect(sources.map((s) => s.id)).toEqual(['gemini-tts', 'local-endpoint']);
    expect(sources[0].default).toBe(true);
    expect(sources[1].default).toBe(false);
    expect(sources[0].modelId).toBe('gemini-3.8-flash-lite-tts');
    expect(sources[1].name).toBe('Supertonic 3');
    expect(JSON.stringify(sources)).not.toMatch(/fixture-only|disabled-fixture|127\.0\.0\.1/);
    expect((await sources[0].createProvider()).providerId).toBe('gemini-tts');
    f.row.enabled_provider_ids = ['local-endpoint'];
    expect((await loadPlainTTSSources(f.pool, f.config, f.env)).map((s) => s.id)).toEqual(['local-endpoint']);
  });

  it('invalidates the voice/audio identity when saved model or delivery options change', async () => {
    const f = fixture();
    const before = (await loadPlainTTSSources(f.pool, f.config, f.env))[0];
    f.row.provider_options['gemini-tts'].voice = 'Puck';
    const after = (await loadPlainTTSSources(f.pool, f.config, f.env))[0];
    expect(after.revision).not.toBe(before.revision);
    expect(after.synthesisRevision).toBe(before.synthesisRevision);
  });

  it('keeps the selected model identity across catalog, default and credential-timestamp changes', async () => {
    const f = fixture();
    const before = (await loadPlainTTSSources(f.pool, f.config, f.env)).find((s) => s.id === 'gemini-tts')!;
    f.row.updated_at = '2026-10-26T12:00:00Z';
    f.row.default_provider_id = 'local-endpoint';
    const after = (await loadPlainTTSSources(f.pool, f.config, f.env)).find((s) => s.id === 'gemini-tts')!;
    expect(after.revision).not.toBe(before.revision);
    expect(after.synthesisRevision).toBe(before.synthesisRevision);
    f.row.model_overrides = { 'gemini-tts': 'another-model' };
    expect(
      (await loadPlainTTSSources(f.pool, f.config, f.env)).find((s) => s.id === 'gemini-tts')!.synthesisRevision,
    ).not.toBe(before.synthesisRevision);
  });
});

it('does not infer a paid default from the enabled list when no default is selected', async () => {
  const f = fixture();
  f.row.default_provider_id = '';
  f.row.enabled_provider_ids = ['gemini-tts'];
  const sources = await loadPlainTTSSources(f.pool, f.config, f.env);
  expect(sources).toHaveLength(1);
  expect(sources[0].default).toBe(false);
});
