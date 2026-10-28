import { afterEach, expect, it, vi } from 'vitest';
import { createAudiobookPort } from './audiobook-client';
import { RemoteApiClient, RemoteApiRequestTimeoutError } from './remote-api-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stalledFetch() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    init?.signal?.addEventListener('abort', () => body.error(init.signal!.reason), { once: true });
    return new Response(stream, { headers: { 'Content-Type': 'audio/wav' } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, finish: () => body.close() };
}

it('bounds a saved audio body even after headers arrive, without repeating the request', async () => {
  vi.useFakeTimers();
  const f = stalledFetch();
  const client = new RemoteApiClient('https://fixture.invalid/api');
  const result = client.requestBlob('/audio', {}, 100, undefined, undefined, true);
  const rejected = expect(result).rejects.toBeInstanceOf(RemoteApiRequestTimeoutError);
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('preserves long file downloads and caller cancellation', async () => {
  vi.useFakeTimers();
  const f = stalledFetch();
  const client = new RemoteApiClient('https://fixture.invalid/api');
  let settled = false;
  const result = client.requestBlob('/large-file', {}, 100).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  f.finish();
  await result;
  const abort = new AbortController();
  const cancelled = client.requestBlob('/audio', { signal: abort.signal }, 1000, undefined, undefined, true);
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejected;
});

it.each(['reader', 'resolve'] as const)(
  'bounds the complete %s response body without automatically repeating a paid POST',
  async (phase) => {
    vi.useFakeTimers();
    const f = stalledFetch();
    const client = new RemoteApiClient('https://fixture.invalid/api');
    const port = createAudiobookPort(client, 'book');
    const signal = new AbortController().signal;
    const result =
      phase === 'reader' ? port.reader('chapter', { id: 'saved' }, signal) : port.resolve('saved', 2, true, signal);
    const rejected = expect(result).rejects.toBeInstanceOf(RemoteApiRequestTimeoutError);
    const limit = phase === 'reader' ? 30_000 : 150_000;
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const init = f.fetch.mock.calls[0][1];
    expect(init?.method ?? 'GET').toBe(phase === 'reader' ? 'GET' : 'POST');
    if (phase === 'resolve') expect(JSON.parse(String(init?.body))).toEqual({ regenerate: true });
  },
);
