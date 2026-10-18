import Fastify from 'fastify';
import type pg from 'pg';
import { expect, it } from 'vitest';
import type { ServerConfig } from '../../config.js';
import { registerReaderStateRoutes } from './reader-state-routes.js';
import { resolveTTSPlaybackSettings } from '../../../../../src/providers/tts-playback-settings';

it('retains narration units through PUT, server recreation, GET, and book changes', async () => {
  const saved = new Map<string, unknown>();
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      if (sql.includes('insert into reader_settings'))
        saved.set(String(parameters[0]), JSON.parse(String(parameters[1])));
      if (sql.includes('select settings from reader_settings'))
        return { rows: saved.has(String(parameters[0])) ? [{ settings: saved.get(String(parameters[0])) }] : [] };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  for (const plainChunking of ['sentence', 'paragraph', 'batch'] as const) {
    const writer = Fastify();
    writer.addHook('onRequest', async (request) => {
      request.principal = { userId: 'fixture', role: 'admin', authMethod: 'legacy-token' };
    });
    await registerReaderStateRoutes(writer, pool, { defaultUserId: 'fixture' } as ServerConfig);
    try {
      const result = await writer.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: {
          ttsPlayback: { plainChunking, voiceSource: 'server' },
          ttsBookOverrides: { book_a: { plainChunking: 'paragraph' } },
        },
      });
      expect(result.statusCode).toBe(200);
    } finally {
      await writer.close();
    }
    const reader = Fastify();
    reader.addHook('onRequest', async (request) => {
      request.principal = { userId: 'fixture', role: 'admin', authMethod: 'legacy-token' };
    });
    await registerReaderStateRoutes(reader, pool, { defaultUserId: 'fixture' } as ServerConfig);
    try {
      const settings = (await reader.inject('/api/settings')).json().settings;
      expect(resolveTTSPlaybackSettings(settings).plainChunking).toBe(plainChunking);
      expect(resolveTTSPlaybackSettings(settings, 'book_a').plainChunking).toBe('paragraph');
      expect(resolveTTSPlaybackSettings(settings, 'book_b').plainChunking).toBe(plainChunking);
      expect(resolveTTSPlaybackSettings(settings, 'book_a').plainChunking).toBe('paragraph');
    } finally {
      await reader.close();
    }
  }
});
