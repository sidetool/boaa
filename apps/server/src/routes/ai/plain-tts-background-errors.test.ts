import { TransientTTSError } from '../../providers/tts-transient-error.js';
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

it.each(['policy', 'deadline', 'unavailable'] as const)(
  'records safe %s diagnostics from background synthesis and marks only provider transients retryable',
  async (kind) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'boaa-background-error-'));
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'api', sink: { write: (line) => lines.push(line) } });
    const app = Fastify({ loggerInstance: logger.fastify });
    const providerError =
      kind === 'policy'
        ? new GeminiAudioResponseError('provider_finish_reason', 'SAFETY')
        : kind === 'deadline'
          ? new DOMException('provider converted timeout', 'AbortError')
          : Object.assign(new Error('private response'), { status: 503, retryAfterSeconds: 90 });
    const synthesize = vi.fn().mockRejectedValue(providerError);
    let deadline: ReturnType<typeof vi.spyOn> | undefined;
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
      if (kind === 'deadline')
        deadline = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(AbortSignal.abort(new DOMException('deadline', 'TimeoutError')));
      const attempt = args[5]('private novel text', voice.id, voice.model!, 'fixture-key', false);
      if (kind === 'policy')
        await expect(attempt).rejects.toMatchObject({
          code: 'tts_incomplete_audio',
          message: expect.stringContaining('콘텐츠 제한'),
        });
      else {
        await expect(attempt).rejects.toBeInstanceOf(TransientTTSError);
        if (deadline) expect(deadline).toHaveBeenCalledWith(180_000);
      }
      expect(synthesize).toHaveBeenCalledOnce();
      const failures = lines.map((line) => JSON.parse(line)).filter((line) => line.event === 'plain_tts_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        component: 'gemini-vertex-tts',
        inputCharacters: 18,
        errorCategory:
          kind === 'policy'
            ? 'tts_content_blocked'
            : kind === 'deadline'
              ? 'tts_timeout'
              : 'tts_temporarily_unavailable',
      });
      if (kind === 'policy')
        expect(failures[0]).toMatchObject({ errorCode: 'provider_finish_reason', state: 'SAFETY' });
      expect(lines.join('\n')).not.toMatch(/private novel text|private-connection/);
    } finally {
      deadline?.mockRestore();
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
