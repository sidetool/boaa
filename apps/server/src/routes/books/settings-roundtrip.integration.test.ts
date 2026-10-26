import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultSettings } from '@boaa/reader-core/settings';
import { sharedReaderSettings } from '@boaa/reader-core/settings-scope';
import type { ServerConfig } from '../../config.js';
import { registerReaderStateRoutes } from './reader-state-routes.js';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
  POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS,
} from '../../services/id-v2-migration/postgres-integration-harness.js';
import { resolveTTSPlaybackSettings } from '../../../../../src/providers/tts-playback-settings';

const harness = await startPostgresIntegrationHarness();
afterAll(() => harness?.stop(), POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS);
(harness ? describe : describe.skip)('settings HTTP and PostgreSQL persistence', () => {
  it('retains batch sizes, voices and unrelated settings after reconnect, unrelated edits and rejected saves', async () => {
    await withPostgresSchema(harness!, 'settings_roundtrip', async (pool) => {
      await pool.query(
        'create table reader_settings(user_id text primary key, settings jsonb not null, updated_at timestamptz not null default now())',
      );
      await pool.query(
        'create table sync_events(id text, user_id text, unique(user_id,id), device_id text, type text, book_id text, entity_id text, payload jsonb, revision jsonb, created_at timestamptz)',
      );
      const reserved = {
        _boaaIntegrations: { sentinel: 'preserve' },
        _boaaDiscovery: { sentinel: 'preserve' },
        readingProfile: { fontSize: 29 },
      };
      await pool.query('insert into reader_settings values($1,$2,now())', ['fixture', JSON.stringify(reserved)]);
      const serverVoiceId = 'connection-00000000-0000-4000-8000-000000000000:' + 'v'.repeat(200);
      const settings = {
        ...defaultSettings,
        ttsSpeed: 1.3,
        ttsPlayback: {
          ...defaultSettings.ttsPlayback,
          voiceSource: 'server' as const,
          serverVoiceId,
          plainChunking: 'batch' as const,
          plainBatchCharacters: 1200,
          rate: 1.3,
          sleepTimerDefault: 20 as const,
        },
        ttsBookOverrides: { book: { plainBatchCharacters: 300, sleepTimerDefault: null } },
        downloadPolicy: { autoNext: true, nextCount: 3 as const, retentionEnabled: true, keepRead: 10 as const },
        homeRows: [{ id: 'favorites', kind: 'favorites' as const, visible: false }],
        recentSearches: ['test query'],
        aiWorkflows: { schemaVersion: 1 as const, defaultWorkflowId: 'fixture.workflow', bookOverrides: {} },
      };
      const start = async () => {
        const app = Fastify();
        app.addHook('onRequest', async (request) => {
          request.principal = { userId: 'fixture', role: 'admin', authMethod: 'legacy-token' };
        });
        await registerReaderStateRoutes(app, pool, { defaultUserId: 'fixture' } as ServerConfig);
        return app;
      };
      const writer = await start();
      try {
        expect(
          (await writer.inject({ method: 'PUT', url: '/api/settings', payload: sharedReaderSettings(settings) }))
            .statusCode,
        ).toBe(200);
      } finally {
        await writer.close();
      }
      const reader = await start();
      try {
        const loaded = (await reader.inject('/api/settings')).json().settings;
        expect(sharedReaderSettings(loaded)).toEqual(sharedReaderSettings(settings));
        expect(resolveTTSPlaybackSettings(loaded)).toMatchObject({ plainBatchCharacters: 1200, serverVoiceId });
        expect(resolveTTSPlaybackSettings(loaded, 'book')).toMatchObject({
          plainBatchCharacters: 300,
          sleepTimerDefault: undefined,
        });
        const changed = { ...sharedReaderSettings(loaded), recentSearches: ['changed query'] };
        expect((await reader.inject({ method: 'PUT', url: '/api/settings', payload: changed })).statusCode).toBe(200);
        const after = (await reader.inject('/api/settings')).json().settings;
        expect(sharedReaderSettings(after)).toEqual(changed);
        const stored = (await pool.query('select settings from reader_settings')).rows[0].settings;
        expect(stored).toMatchObject(reserved);
        expect(
          (
            await reader.inject({
              method: 'PUT',
              url: '/api/settings',
              payload: { ...changed, ttsPlayback: { ...settings.ttsPlayback, plainBatchCharacters: 2001 } },
            })
          ).statusCode,
        ).toBe(400);
        expect((await pool.query('select settings from reader_settings')).rows[0].settings).toEqual(stored);
        const events = (await pool.query('select payload from sync_events')).rows;
        expect(events).toHaveLength(2);
        for (const event of events) {
          expect(event.payload.settings.ttsPlayback.plainBatchCharacters).toBe(1200);
          expect(event.payload.settings.ttsBookOverrides.book.plainBatchCharacters).toBe(300);
        }
      } finally {
        await reader.close();
      }
    });
  });
});
