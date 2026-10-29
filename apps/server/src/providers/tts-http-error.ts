/** Preserve only HTTP status and a bounded Retry-After, never a provider response or credentials. */
export function ttsHttpError(message: string, response: Response, now = Date.now()): Error {
  const header = response.headers.get('retry-after');
  const numeric = header?.trim() ? Number(header) : NaN;
  const seconds = Number.isFinite(numeric) ? numeric : header ? (Date.parse(header) - now) / 1000 : NaN;
  return Object.assign(new Error(message), {
    status: response.status,
    ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.min(86400, Math.ceil(seconds)) } : {}),
  });
}

/** Google also sends retry timing in RPC details. Retain only timing, never its message/project identifiers. */
export async function googleTtsHttpError(message: string, response: Response): Promise<Error> {
  const error = ttsHttpError(message, response) as Error & { retryAfterSeconds?: number; voiceCreationQuota?: number };
  const reader = response.body?.getReader();
  if (!reader) return error;
  if (response.status !== 429) {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    return error;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const timeout = setTimeout(() => void reader.cancel().catch(() => {}), 2000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) return error;
      chunks.push(part.value);
    }
    const details = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error?.details;
    if (Array.isArray(details))
      for (const detail of details) {
        if (
          detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          detail.metadata?.quota_metric === 'aiplatform.googleapis.com/voice_creations' &&
          typeof detail.metadata.quota_limit_value === 'string' &&
          /^\d{1,9}$/.test(detail.metadata.quota_limit_value)
        ) {
          error.voiceCreationQuota = Number(detail.metadata.quota_limit_value);
        }
        if (
          detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo' ||
          typeof detail.retryDelay !== 'string' ||
          !/^\d+(?:\.\d{1,9})?s$/.test(detail.retryDelay)
        )
          continue;
        const seconds = Number(detail.retryDelay.slice(0, -1));
        if (Number.isFinite(seconds) && seconds > 0)
          error.retryAfterSeconds = Math.max(error.retryAfterSeconds ?? 0, Math.min(86400, Math.ceil(seconds)));
      }
  } catch {
    // A malformed/truncated error body still preserves the original status and Retry-After header.
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return error;
}
