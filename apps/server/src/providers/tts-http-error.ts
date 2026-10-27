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
