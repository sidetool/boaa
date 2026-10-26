import Fastify from 'fastify';
import type pg from 'pg';
import type { TTSPlaybackSettings, TTSPlaybackSettingsOverride } from '@boaa/contracts';
import { validateSettingsBody } from './request-contracts.js';
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
          ttsPlayback: { ...allPlayback, plainChunking },
          ttsBookOverrides: { book_a: { ...allOverrides, plainChunking: 'paragraph' } },
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
      expect(settings.ttsPlayback).toEqual({ ...allPlayback, plainChunking });
      expect(settings.ttsBookOverrides.book_a).toEqual({ ...allOverrides, plainChunking: 'paragraph' });
      expect(resolveTTSPlaybackSettings(settings)).toEqual({ ...allPlayback, plainChunking });
      expect(resolveTTSPlaybackSettings(settings, 'book_a')).toEqual({
        ...allPlayback,
        ...allOverrides,
        plainChunking: 'paragraph',
      });
      expect(resolveTTSPlaybackSettings(settings).plainChunking).toBe(plainChunking);
      expect(resolveTTSPlaybackSettings(settings, 'book_a').plainChunking).toBe('paragraph');
      expect(resolveTTSPlaybackSettings(settings, 'book_b').plainChunking).toBe(plainChunking);
      expect(resolveTTSPlaybackSettings(settings, 'book_a').plainChunking).toBe('paragraph');
    } finally {
      await reader.close();
    }
  }
});

// Required makes newly introduced optional settings part of this persistence regression too.
const allPlayback = {
  schemaVersion: 1,
  mode: 'plain',
  voiceSource: 'server',
  serverVoiceId: 'fixture:voice',
  plainChunking: 'batch',
  plainBatchCharacters: 1200,
  rate: 1.4,
  pitch: 1.2,
  volume: 0.7,
  sentencePauseMs: 230,
  paragraphPauseMs: 630,
  chapterPauseMs: 1230,
  chapterEndBehavior: 'continue',
  footnotePlayback: 'immediate',
  offlineOnly: true,
  sleepTimerDefault: 20,
  skippedContentTypes: ['author_note', 'sfx'],
} satisfies Required<TTSPlaybackSettings>;
const { schemaVersion: _schema, ...rest } = allPlayback;
void _schema;
const allOverrides = { ...rest, plainBatchCharacters: 300, rate: 1.7 } satisfies Required<TTSPlaybackSettingsOverride>;

it.each([200, 700, 1200, 2000])('preserves batch size %s globally and per book', (plainBatchCharacters) => {
  const parsed = validateSettingsBody({
    ttsPlayback: { ...allPlayback, plainBatchCharacters },
    ttsBookOverrides: { a: { plainBatchCharacters } },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.ttsPlayback.plainBatchCharacters).toBe(plainBatchCharacters);
  expect(parsed.value.ttsBookOverrides?.a).toEqual({ plainBatchCharacters });
});
it.each([199, 2001, -1, 1200.5, '1200', null])(
  'rejects invalid batch size %s instead of silently dropping it',
  (plainBatchCharacters) => {
    for (const payload of [
      { ttsPlayback: { plainBatchCharacters } },
      { ttsBookOverrides: { a: { plainBatchCharacters } } },
    ])
      expect(validateSettingsBody(payload).ok).toBe(false);
  },
);
it('keeps a long composite server voice ID intact through save and runtime normalization', () => {
  const serverVoiceId = 'connection-00000000-0000-4000-8000-000000000000:' + 'a'.repeat(464);
  expect(serverVoiceId.length).toBeLessThanOrEqual(512);
  const parsed = validateSettingsBody({
    ttsPlayback: { ...allPlayback, serverVoiceId },
    ttsBookOverrides: { a: { serverVoiceId } },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(resolveTTSPlaybackSettings(parsed.value).serverVoiceId).toBe(serverVoiceId);
  expect(resolveTTSPlaybackSettings(parsed.value, 'a').serverVoiceId).toBe(serverVoiceId);
  expect(validateSettingsBody({ ttsPlayback: { serverVoiceId: 'x'.repeat(513) } }).ok).toBe(false);
});
