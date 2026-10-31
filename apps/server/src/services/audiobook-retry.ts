import { TransientTTSError } from '../providers/tts-transient-error.js';

export const AUDIO_RETRY_LIMIT = 5;
export function retryDelay(error: unknown): number {
  const detail = error as { retryAfterSeconds?: number; payload?: { retryAfterSeconds?: number } } | null;
  const value = detail?.retryAfterSeconds ?? detail?.payload?.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(86400, Math.max(0, value)) : 0;
}

/** Permanent failures win; mixed quota/timeout failures still consume the bounded audio retry budget. */
export function batchFailure(errors: unknown[], classify: (error: unknown) => { status: number }): unknown {
  const permanent = errors.find((error) => !(error instanceof TransientTTSError) && classify(error).status !== 429);
  if (permanent) return permanent;
  const transient = errors.find((error) => error instanceof TransientTTSError);
  if (transient instanceof TransientTTSError)
    return new TransientTTSError(transient.kind, transient.upstreamStatus, Math.max(...errors.map(retryDelay)));
  return errors.reduce<unknown>((a, b) => (retryDelay(a) >= retryDelay(b) ? a : b), undefined);
}
