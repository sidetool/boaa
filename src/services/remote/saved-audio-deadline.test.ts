import { afterEach, expect, it, vi } from 'vitest';
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
