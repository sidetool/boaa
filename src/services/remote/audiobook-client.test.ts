import { describe, expect, it, vi } from 'vitest';
import { createAudiobookPort } from './audiobook-client';
import type { RemoteApiClient } from './remote-api-client';

describe('saved audiobook transport', () => {
  it('serializes positions across playback page lifetimes and continues after a failed save', async () => {
    let release!: () => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      )
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({});
    const port = createAudiobookPort({ request } as unknown as RemoteApiClient, 'book');
    const old = port.progress('saved', 9);
    await Promise.resolve();
    const reopened = port.progress('saved', 2);
    const failed = expect(reopened).rejects.toThrow('temporary');
    const latest = port.progress('saved', 3);
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await old;
    await failed;
    await latest;
    expect(request.mock.calls.map(([, init]) => JSON.parse(init.body).index)).toEqual([9, 2, 3]);
  });
  it('reads saved audio through authenticated blob transport without creating a job', async () => {
    const blob = new Blob(['fixture'], { type: 'audio/wav' });
    const request = vi.fn();
    const requestBlob = vi.fn().mockResolvedValue({ blob });
    const port = createAudiobookPort({ request, requestBlob } as unknown as RemoteApiClient, 'book');
    const controller = new AbortController();
    expect(await port.audio('saved', 2, controller.signal)).toBe(blob);
    expect(requestBlob).toHaveBeenCalledWith(
      '/audiobooks/saved/audio/2',
      { signal: controller.signal },
      30000,
      undefined,
      undefined,
      true,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
