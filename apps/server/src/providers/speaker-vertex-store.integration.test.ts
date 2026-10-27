import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { SpeakerEngineStore } from './speaker-engine-store';
import { loadConfig } from '../config';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../services/id-v2-migration/postgres-integration-harness';

const harness = await startPostgresIntegrationHarness();
afterAll(async () => {
  await harness?.stop();
}, POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
it.skipIf(!harness)(
  'keeps Vertex JSON encrypted, write-only, owner-bound and stable across edits/toggles',
  async () => {
    await withPostgresSchema(harness!, 'vertex_credentials', async (pool) => {
      await pool.query("create table users(id text primary key); insert into users values('owner'),('other')");
      const migration = await readFile(
        new URL('../db/migrations/0068_speaker_generation.sql', import.meta.url),
        'utf8',
      );
      await pool.query(migration.split(';')[0]!);
      const make = (owner: string) =>
        new SpeakerEngineStore(pool, loadConfig({ DEFAULT_USER_ID: owner }), {
          PROVIDER_SECRET_ENCRYPTION_KEY: '11'.repeat(32),
        });
      const store = make('owner');
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const json = JSON.stringify({
        type: 'service_account',
        project_id: 'fixture-project',
        client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
        private_key: key,
      });
      const saved = await store.save({
        protocol: 'vertex',
        inputFormat: 'pdf',
        name: 'Private',
        purpose: 'casting',
        engineUrl: 'http://speaker-engine:8095',
        modelId: 'chosen-model',
        serviceAccountJson: json,
        maxOutputTokens: 4096,
        enabled: true,
        paid: true,
      });
      expect(saved).toMatchObject({ hasServiceAccount: true, projectId: 'fixture-project', location: 'global' });
      expect(saved).not.toHaveProperty('serviceAccountJson');
      expect(JSON.stringify((await pool.query('select * from speaker_engines')).rows)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(await store.list())).not.toContain('private_key');
      const edited = await store.save({ ...saved, name: 'Renamed' }, saved.id);
      expect(edited.revision).toBe(saved.revision);
      expect((await make('owner').loadCasting(saved.id)).inputFormat).toBe('pdf');
      const text = await store.save({ ...edited, inputFormat: undefined }, saved.id);
      expect(text.revision).toBe(saved.revision);
      expect((await make('owner').loadCasting(saved.id)).inputFormat).toBeUndefined();
      await store.save(edited, saved.id);
      expect(JSON.parse((await make('owner').loadCasting(saved.id)).serviceAccountJson!).private_key).toBe(key);
      await store.save({ ...edited, enabled: false }, saved.id);
      await store.save({ ...edited, enabled: true }, saved.id);
      expect((await store.load(saved.id)).serviceAccountJson).toBeTruthy();
      await expect(make('other').load(saved.id)).rejects.toMatchObject({ statusCode: 404 });
      expect(await make('other').list()).toEqual([]);
      await store.save(
        { ...edited, inputFormat: undefined, protocol: 'openai', url: 'https://custom.invalid/v1', apiKey: 'new-key' },
        saved.id,
      );
      expect(await store.load(saved.id)).not.toHaveProperty('serviceAccountJson');
      const back = await store.save({ ...edited }, saved.id);
      expect(back.hasServiceAccount).toBe(false);
    });
  },
  30000,
);
