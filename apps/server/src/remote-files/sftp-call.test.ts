import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { sftpCall } from './sftp-call.js';

it.each(['abort', 'close', 'error'] as const)('settles a lost SFTP callback on %s', async (event) => {
  const client = new EventEmitter();
  const controller = new AbortController();
  let callback!: (error: Error | null, value: string) => void;
  const pending = sftpCall<string>(client, controller.signal, (cb) => {
    callback = cb;
  });
  const rejected = expect(pending).rejects.toThrow();
  if (event === 'abort') controller.abort();
  else if (event === 'error') client.emit('error', new Error('connection lost'));
  else client.emit('close');
  await rejected;
  callback(null, 'late');
  expect(client.listenerCount('close')).toBe(0);
  expect(client.listenerCount('error')).toBe(0);
});
it('does not start a request after cancellation and cleans up successful requests', async () => {
  const client = new EventEmitter();
  const controller = new AbortController();
  controller.abort();
  const run = vi.fn();
  await expect(sftpCall(client, controller.signal, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await expect(sftpCall(client, new AbortController().signal, (cb) => cb(null, 12))).resolves.toBe(12);
  expect(client.eventNames()).toEqual([]);
});
