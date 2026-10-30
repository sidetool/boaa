import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { createStructuredLogger } from '../../observability/logger.js';
import { GeminiAudioResponseError } from '../../providers/gemini-audio-response.js';
import type { SpeakerGenerationService } from '../../services/speaker-generation-service.js';
import { registerPlainTTSRoutes } from './plain-tts-routes.js';

const captures = vi.hoisted(() => ({ speaker: vi.fn() }));
// Capture the background service's real synthesis callback; do not pass through the HTTP error handler.
vi.mock('./audiobook-routes.js', () => ({ registerAudiobookRoutes: vi.fn(async () => ({})) }));
vi.mock('./speaker-generation-routes.js', () => ({ registerSpeakerGenerationRoutes: vi.fn() }));
vi.mock('./voice-library-routes.js', () => ({ registerVoiceLibraryRoutes: vi.fn() }));
vi.mock('../../services/speaker-generation-service.js', () => ({
  SpeakerGenerationService: class {
    constructor(...args: unknown[]) {
      captures.speaker(...args);
    }
  },
}));

it('records safe completion diagnostics from background synthesis after production log redaction', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'boaa-background-error-'));
  const lines: string[] = [];
  const logger = createStructuredLogger({ service: 'api', sink: { write: (line) => lines.push(line) } });
  const app = Fastify({ loggerInstance: logger.fastify });
  const synthesize = vi.fn().mockRejectedValue(new GeminiAudioResponseError('provider_finish_reason', 'SAFETY'));
  try {
    await registerPlainTTSRoutes(
      app,
      { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool,
      { ...loadConfig({ DEFAULT_USER_ID: 'fixture-owner' }), dataDir },
      {
        savedAudiobooks: true,
        audiobookBackground: false,
        env: {},
        sources: async () => [
          {
            id: 'private-connection',
            name: 'private-connection-name',
            modelId: 'gemini-3.8-flash-tts',
            revision: 'fixture-revision',
            paid: false,
            createProvider: async () => ({
              providerId: 'gemini-vertex-tts',
              displayName: 'fixture',
              supportsStreaming: false,
              supportsAudioCache: true,
              supportsPerCharacterVoice: true,
              listVoices: async () => [{ id: 'Kore', label: 'Kore', lang: 'ko' }],
              synthesize,
            }),
          },
        ],
      },
    );
    const args = captures.speaker.mock.lastCall as ConstructorParameters<typeof SpeakerGenerationService>;
    const catalog = await args[4]();
    const voice = catalog.voices[0];
    await expect(args[5]('private novel text', voice.id, voice.model!, 'fixture-key', false)).rejects.toMatchObject({
      code: 'tts_incomplete_audio',
      message: expect.stringContaining('콘텐츠 제한'),
    });
    expect(synthesize).toHaveBeenCalledOnce();
    const failures = lines.map((line) => JSON.parse(line)).filter((line) => line.event === 'plain_tts_failed');
    expect(failures).toEqual([
      expect.objectContaining({
        errorCategory: 'tts_incomplete_audio',
        errorCode: 'provider_finish_reason',
        state: 'SAFETY',
        component: 'gemini-vertex-tts',
        inputCharacters: 18,
      }),
    ]);
    expect(lines.join('\n')).not.toMatch(/private novel text|private-connection/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
