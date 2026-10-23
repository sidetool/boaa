/** A controller job owns its timer; cancelling the invocation releases it immediately. */
export function sleepControllerJob(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Error('CANCELLED'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(Error('CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
