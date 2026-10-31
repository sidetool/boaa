import { expect, it } from 'vitest';
import { GeminiAudioResponseError } from './gemini-audio-response.js';
import { TTSContentBlockedError } from './tts-content-block.js';
import { transientTTSFailure, TransientTTSError } from './tts-transient-error.js';
import { batchFailure } from '../services/audiobook-retry.js';

it('recognizes provider timeouts, unavailable HTTP responses and known transport failures', () => {
  for (const error of [new DOMException('deadline', 'TimeoutError'), { status: 408 }, { status: 504 }])
    expect(transientTTSFailure(error)).toMatchObject({ kind: 'timeout' });
  for (const error of [{ status: 500 }, { status: 502 }, { status: 503 }, { cause: { code: 'ECONNRESET' } }])
    expect(transientTTSFailure(error)).toMatchObject({ kind: 'unavailable' });
  expect(transientTTSFailure({ status: 503, retryAfterSeconds: 900 })).toMatchObject({ retryAfterSeconds: 900 });
});

it('does not infer retries from cancellation, policy refusals, invalid audio or unknown errors', () => {
  for (const error of [
    new DOMException('stop', 'AbortError'),
    new TTSContentBlockedError('content_filter'),
    new GeminiAudioResponseError('provider_finish_reason', 'MAX_TOKENS'),
    { status: 502, code: 'tts_incomplete_audio' },
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { status: 400 },
    new Error('timeout'),
    new TypeError('bad code'),
    null,
  ])
    expect(transientTTSFailure(error)).toBeUndefined();
});

it('preserves permanent failures and counts mixed timeout/quota batches as bounded audio retries', () => {
  const timeout = new TransientTTSError('timeout');
  const limited = { status: 429, retryAfterSeconds: 600 };
  const classify = (error: unknown) => ({ status: (error as { status?: number }).status ?? 502 });
  const mixed = batchFailure([limited, timeout], classify);
  expect(mixed).toBeInstanceOf(TransientTTSError);
  expect(mixed).toMatchObject({ retryAfterSeconds: 600 });
  const permanent = new Error('disk failure');
  expect(batchFailure([limited, timeout, permanent], classify)).toBe(permanent);
});
