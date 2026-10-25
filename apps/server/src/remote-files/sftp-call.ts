import type { EventEmitter } from 'node:events';
import { failure } from './common.js';

/** SSH may close without invoking an outstanding SFTP callback. */
export function sftpCall<T>(
  client: EventEmitter,
  signal: AbortSignal,
  run: (callback: (error: Error | undefined | null, value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, value?: T) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', cancel);
      client.removeListener('close', closed);
      client.removeListener('error', failed);
      if (error) reject(error);
      else resolve(value!);
    };
    const cancel = () => finish(signal.reason ?? failure('cancelled'));
    const closed = () => finish(failure('unavailable'));
    const failed = (error: Error) => finish(error);
    signal.addEventListener('abort', cancel, { once: true });
    client.once('close', closed);
    client.once('error', failed);
    if (signal.aborted) return cancel();
    try {
      run((error, value) => finish(error, value));
    } catch (error) {
      finish(error);
    }
  });
}
