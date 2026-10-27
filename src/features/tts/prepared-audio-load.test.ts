import { expect, it, vi } from 'vitest';
import type { AudiobookPort } from '../../providers/plain-audiobook';
import { loadPreparedAudio } from './prepared-audio-load';

it('uses newly ready files even when the chapter snapshot still says pending', async () => {
  const audio = vi.fn().mockResolvedValue(new Blob(['saved']));
  const resolve = vi.fn();
  const port = { audio, resolve } as unknown as AudiobookPort;
  await loadPreparedAudio(port, { id: 'job', ordinal: 2, ready: false }, new AbortController().signal);
  expect(audio).toHaveBeenCalledOnce();
  expect(resolve).not.toHaveBeenCalled();
});
it('only generates a pending, confirmed absent item; read failures never invoke generation', async () => {
  const resolve = vi.fn().mockResolvedValue(new Blob(['new']));
  const audio = vi.fn();
  const port = { audio, resolve } as unknown as AudiobookPort;
  for (const ready of [true, false])
    for (const status of [403, 404, 410, 429, 502, 504]) {
      resolve.mockClear();
      audio.mockRejectedValue({ status });
      const result = loadPreparedAudio(port, { id: 'job', ordinal: 2, ready }, new AbortController().signal);
      if (!ready && status === 404) {
        await expect(result).resolves.toBeInstanceOf(Blob);
        expect(resolve).toHaveBeenCalledWith('job', 2, false, expect.any(AbortSignal));
      } else {
        await expect(result).rejects.toMatchObject({ status });
        expect(resolve).not.toHaveBeenCalled();
      }
    }
});
it('does not generate after cancellation during the readiness check', async () => {
  const abort = new AbortController();
  const resolve = vi.fn();
  const audio = vi.fn(async () => {
    abort.abort();
    throw { status: 404 };
  });
  await expect(
    loadPreparedAudio(
      { audio, resolve } as unknown as AudiobookPort,
      { id: 'job', ordinal: 0, ready: false },
      abort.signal,
    ),
  ).rejects.toBeDefined();
  expect(resolve).not.toHaveBeenCalled();
});
