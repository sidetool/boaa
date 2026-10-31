import { GeminiAudioResponseError } from './gemini-audio-response.js';
import { ttsContentBlockReason } from './tts-content-block.js';

/** Only created at the synthesis adapter boundary, never for storage/analysis failures. */
export class TransientTTSError extends Error {
  constructor(
    readonly kind: 'timeout' | 'unavailable',
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(kind === 'timeout' ? '음성 서비스의 응답이 늦어지고 있어요.' : '음성 서비스에 일시적인 연결 문제가 있어요.');
  }
}

/** A completed failed attempt may be retried; cancellation and invalid output are separate. */
export function transientTTSFailure(error: unknown): TransientTTSError | undefined {
  if (error instanceof TransientTTSError) return error;
  if (!error || typeof error !== 'object' || error instanceof GeminiAudioResponseError || ttsContentBlockReason(error))
    return;
  const value = error as {
    name?: string;
    code?: unknown;
    status?: unknown;
    retryAfterSeconds?: number;
    cause?: { code?: unknown };
  };
  if (value.name === 'AbortError' || value.code === 'tts_incomplete_audio') return;
  const raw = value.status ?? value.code;
  const status = typeof raw === 'number' ? raw : undefined;
  const hint = Number.isFinite(value.retryAfterSeconds)
    ? Math.min(86400, Math.max(0, value.retryAfterSeconds!))
    : undefined;
  if (value.name === 'TimeoutError' || status === 408 || status === 504)
    return new TransientTTSError('timeout', status, hint);
  if (status !== undefined)
    return [500, 502, 503].includes(status) ? new TransientTTSError('unavailable', status, hint) : undefined;
  const code = value.cause?.code ?? value.code;
  if (
    typeof code === 'string' &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code)
  )
    return new TransientTTSError('unavailable', undefined, hint);
}
