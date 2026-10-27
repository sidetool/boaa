import { describe, expect, it, vi } from 'vitest';
import { requestPlainTTSWithRetry, requestSavedAudioWithRetry } from './plain-tts-retry';
describe('ordinary TTS retry', () => {
  it('keeps the same request while waiting for a bounded provider cooldown', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, payload: { retryAfterSeconds: 12 } })
      .mockResolvedValue('audio');
    const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {}),
      onWait = vi.fn();
    expect(await requestPlainTTSWithRetry(request, { signal: new AbortController().signal, wait, onWait })).toBe(
      'audio',
    );
    expect(wait.mock.calls[0][0]).toBe(12000);
    expect(onWait).toHaveBeenCalledWith(12);
  });
  it('never automatically repeats ambiguous timeouts or non-rate-limit errors', async () => {
    for (const status of [403, 502, 504]) {
      const request = vi.fn().mockRejectedValue({ status });
      await expect(requestPlainTTSWithRetry(request, { signal: new AbortController().signal })).rejects.toMatchObject({
        status,
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('stops after three retries and cancels immediately when stopped during a cooldown', async () => {
    const request = vi.fn().mockRejectedValue({ status: 429 });
    await expect(
      requestPlainTTSWithRetry(request, { signal: new AbortController().signal, wait: async () => {} }),
    ).rejects.toMatchObject({ status: 429 });
    expect(request).toHaveBeenCalledTimes(4);
    const abort = new AbortController();
    const onWait = () => abort.abort();
    request.mockClear();
    await expect(requestPlainTTSWithRetry(request, { signal: abort.signal, onWait })).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('retries saved-audio reads after transport errors but never permission, missing files or cancellation', async () => {
  const signal = new AbortController().signal;
  const request = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('network'))
    .mockRejectedValueOnce({ status: 503 })
    .mockResolvedValue('saved');
  const wait = vi.fn(async () => {});
  expect(await requestSavedAudioWithRetry(request, signal, wait)).toBe('saved');
  expect(wait.mock.calls).toEqual([
    [500, signal],
    [1000, signal],
  ]);
  for (const status of [401, 403, 404, 409, 410]) {
    const read = vi.fn().mockRejectedValue({ status });
    await expect(requestSavedAudioWithRetry(read, signal, wait)).rejects.toMatchObject({ status });
    expect(read).toHaveBeenCalledTimes(1);
  }
  const abort = new AbortController();
  const read = vi.fn().mockRejectedValue({ status: 502 });
  await expect(
    requestSavedAudioWithRetry(read, abort.signal, async () => {
      abort.abort();
    }),
  ).rejects.toBeDefined();
  expect(read).toHaveBeenCalledTimes(1);
});
it('bounds saved-audio retry attempts including timeouts', async () => {
  const read = vi.fn().mockRejectedValue({ name: 'RemoteApiRequestTimeoutError' });
  await expect(requestSavedAudioWithRetry(read, new AbortController().signal, async () => {})).rejects.toBeDefined();
  expect(read).toHaveBeenCalledTimes(4);
});
