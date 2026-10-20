import { expect, it, vi } from 'vitest';
import { PlainTTSSessionCache, waitForPlainTTSAudio } from './plain-tts-session-cache';

it('shares pending and completed audio even when the playback listener cancels', async () => {
  const cache = new PlainTTSSessionCache();
  let resolve!: (blob: Blob) => void;
  let signal!: AbortSignal;
  const fetch = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<Blob>((done) => {
      resolve = done;
    });
  });
  const input = { key: 'a', scope: 'voice/revision/rules', chapter: 'c', positions: [0, 1, 3], fetch };
  const first = cache.getOrCreate(input);
  const listener = new AbortController();
  const cancelled = waitForPlainTTSAudio(first, listener.signal);
  listener.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect(signal.aborted).toBe(false);
  const second = cache.getOrCreate(input);
  expect(second).toBe(first);
  const blob = new Blob(['audio']);
  resolve(blob);
  await expect(second).resolves.toBe(blob);
  await expect(cache.getOrCreate(input)).resolves.toBe(blob);
  expect(fetch).toHaveBeenCalledOnce();
  expect(cache.batch(input.scope, 'c', 3)).toEqual([0, 1, 3]);
  expect(cache.batch('other-voice', 'c', 3)).toBeUndefined();
  expect(cache.batch(input.scope, 'other-chapter', 3)).toBeUndefined();
  cache.clear();
  expect(signal.aborted).toBe(true);
  expect(cache.batch(input.scope, 'c', 3)).toBeUndefined();
});

it('does not cache failures and bounds completed audio by both count and bytes', async () => {
  const cache = new PlainTTSSessionCache(2, 10);
  const input = {
    key: 'failed',
    scope: 's',
    chapter: 'c',
    positions: [0],
    fetch: vi.fn(async (): Promise<Blob> => {
      throw Error('failed');
    }),
  };
  await expect(cache.getOrCreate(input)).rejects.toThrow('failed');
  await expect(cache.getOrCreate(input)).rejects.toThrow('failed');
  expect(input.fetch).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 3; index++) {
    await cache.getOrCreate({
      ...input,
      key: String(index),
      positions: [index],
      fetch: async () => new Blob(['123456']),
    });
  }
  expect(cache.batch('s', 'c', 0)).toBeUndefined();
  expect(cache.batch('s', 'c', 1)).toBeUndefined();
  expect(cache.batch('s', 'c', 2)).toEqual([2]);
});

it('does not restore old audio when a disposed session finishes late', async () => {
  const cache = new PlainTTSSessionCache();
  let resolve!: (blob: Blob) => void;
  const pending = cache.getOrCreate({
    key: 'a',
    scope: 's',
    chapter: 'c',
    positions: [0, 1],
    fetch: () =>
      new Promise<Blob>((done) => {
        resolve = done;
      }),
  });
  await Promise.resolve();
  cache.clear();
  resolve(new Blob(['late']));
  await pending;
  expect(cache.batch('s', 'c', 1)).toBeUndefined();
});
