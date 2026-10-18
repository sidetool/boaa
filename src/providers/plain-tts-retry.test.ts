import { describe, expect, it, vi } from 'vitest';
import { requestPlainTTSWithRetry } from './plain-tts-retry';
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
