/** Only a rejected 429 is retried. Never replay a timeout/ambiguous paid request automatically. */
export async function requestPlainTTSWithRetry<T>(
  request: () => Promise<T>,
  options: {
    signal: AbortSignal;
    onWait?: (seconds: number) => void;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const wait = options.wait ?? waitForRetry;
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      options.signal.throwIfAborted();
      const failure = error as { status?: number; payload?: { retryAfterSeconds?: number } };
      if (failure?.status !== 429 || attempt >= 3) throw error;
      const retry = failure.payload?.retryAfterSeconds;
      const seconds =
        typeof retry === 'number' && Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) : 10 * 2 ** attempt;
      options.onWait?.(seconds);
      await wait(seconds * 1000, options.signal);
    }
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** GET-only saved audio: retry transient transport failures without ever invoking synthesis. */
export async function requestSavedAudioWithRetry<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRetry,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await request();
    } catch (error) {
      signal.throwIfAborted();
      const failure = error as { status?: number; name?: string; payload?: { retryAfterSeconds?: number } };
      const transient =
        [408, 429, 502, 503, 504].includes(failure?.status ?? 0) ||
        error instanceof TypeError ||
        failure?.name === 'RemoteApiRequestTimeoutError';
      if (!transient || attempt >= 3) throw error;
      const hint = failure?.payload?.retryAfterSeconds;
      const delay =
        typeof hint === 'number' && Number.isFinite(hint)
          ? Math.max(500, Math.min(60000, hint * 1000))
          : 500 * 2 ** attempt;
      await wait(delay, signal);
    }
  }
}
