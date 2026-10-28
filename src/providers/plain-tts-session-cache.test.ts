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

it('expires only a stalled read lease, rereads fresh audio and ignores a late old completion', async () => {
  vi.useFakeTimers();
  const cache = new PlainTTSSessionCache();
  let signal!: AbortSignal;
  let oldResolve!: (blob: Blob) => void;
  const fetch = vi.fn((current: AbortSignal) => {
    signal = current;
    return new Promise<Blob>((resolve) => {
      oldResolve = resolve;
    });
  });
  const input = { key: 'saved', chapter: 'c', scope: 's', positions: [], readOnly: true, fetch };
  const first = cache.getOrCreate(input);
  const rejected = expect(first).rejects.toThrow('미리 만든 음성');
  try {
    await vi.advanceTimersByTimeAsync(44_999);
    expect(signal.aborted).toBe(false);
    expect(cache.getOrCreate(input)).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    const fresh = new Blob(['fresh saved audio']);
    const second = cache.getOrCreate({ ...input, fetch: async () => fresh });
    await expect(second).resolves.toBe(fresh);
    oldResolve(new Blob(['late obsolete body']));
    await Promise.resolve();
    await expect(cache.getOrCreate(input)).resolves.toBe(fresh);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cache.clear();
    vi.useRealTimers();
  }
});

it('does not expire or duplicate a pending paid resolve or regeneration request', async () => {
  vi.useFakeTimers();
  const cache = new PlainTTSSessionCache();
  let signal!: AbortSignal;
  let resolve!: (blob: Blob) => void;
  const fetch = vi.fn((current: AbortSignal) => {
    signal = current;
    return new Promise<Blob>((done) => {
      resolve = done;
    });
  });
  const input = { key: 'paid', chapter: 'c', scope: 's', positions: [], readOnly: false, fetch };
  try {
    const first = cache.getOrCreate(input);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(signal.aborted).toBe(false);
    expect(cache.getOrCreate(input)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const blob = new Blob(['paid result']);
    resolve(blob);
    await expect(first).resolves.toBe(blob);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cache.clear();
    vi.useRealTimers();
  }
});

it('clears a read lease before dispatch without leaving a detached rejecting timer', async () => {
  vi.useFakeTimers();
  const cache = new PlainTTSSessionCache();
  const fetch = vi.fn(() => new Promise<Blob>(() => undefined));
  try {
    const result = cache.getOrCreate({
      key: 'abandoned',
      chapter: 'c',
      scope: 's',
      positions: [],
      readOnly: true,
      fetch,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    cache.clear();
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(45_000);
  } finally {
    cache.clear();
    vi.useRealTimers();
  }
});
