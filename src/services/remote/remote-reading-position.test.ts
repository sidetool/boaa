import { RemoteReaderRepository, RemoteMutationConflictError } from '../../repositories/remote-reader-repository';
import { ReadingPositionSaveError } from '../../repositories/reading-position-save-error';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteApiClient, RemoteApiError } from './remote-api-client';

const position = {
  chapterId: 'chapter',
  expectedContentRevisionId: 'revision_old',
  paragraphIndex: 46,
  offsetInParagraph: 5,
  chapterProgress: 0.5,
  scrollTop: 4600,
  deviceId: 'device',
  updatedAt: '2026-09-13T01:00:00.000Z',
};
const success = () =>
  new Response(JSON.stringify({ ok: true, applied: true }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('retries a dropped connection with the identical position and timestamp', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const task = new RemoteApiClient('/api').saveReadingPosition('book', position);
  const assertion = expect(task).resolves.toEqual({ ok: true, applied: true });
  await Promise.all([vi.advanceTimersByTimeAsync(1000), assertion]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].keepalive).toBe(true);
  expect(fetch.mock.calls[1][1].keepalive).toBe(true);
  expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
    updatedAt: position.updatedAt,
    expectedContentRevisionId: position.expectedContentRevisionId,
  });
});
it.each([408, 500, 502, 503, 504])('retries a transient HTTP %s once', async (status) => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const assertion = expect(new RemoteApiClient('/api').saveReadingPosition('book', position)).resolves.toMatchObject({
    applied: true,
  });
  await Promise.all([vi.advanceTimersByTimeAsync(1000), assertion]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([400, 401, 403, 404, 409, 429])('does not blindly retry HTTP %s', async (status) => {
  const fetch = vi.fn(async () => new Response('{}', { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(new RemoteApiClient('/api').saveReadingPosition('book', position)).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledOnce();
});
it('stops after the second failure and does not turn a rejected update into a newer write', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
  vi.stubGlobal('fetch', fetch);
  const assertion = expect(new RemoteApiClient('/api').saveReadingPosition('book', position)).rejects.toThrow(
    'offline',
  );
  await Promise.all([vi.advanceTimersByTimeAsync(1000), assertion]);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true, applied: false })));
  expect(await new RemoteApiClient('/api').saveReadingPosition('book', position)).toEqual({ ok: true, applied: false });
  expect(fetch).toHaveBeenCalledOnce();
});
it('does not double the request timeout when the server remains unreachable', async () => {
  const fetch = vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  );
  vi.stubGlobal('fetch', fetch);
  const assertion = expect(
    new RemoteApiClient('/api', { requestTimeoutMs: 1000 }).saveReadingPosition('book', position),
  ).rejects.toMatchObject({ name: 'RemoteApiRequestTimeoutError' });
  await Promise.all([vi.advanceTimersByTimeAsync(2000), assertion]);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  [409, 'response'],
  [401, 'authentication'],
  [403, 'permission'],
  [404, 'missing'],
  [429, 'rate-limit'],
  [500, 'server'],
  [400, 'response'],
])('reports a safe diagnostic for HTTP %s', async (status, reason) => {
  const client = {
    saveReadingPosition: vi.fn(async () => {
      throw new RemoteApiError('private upstream payload', Number(status));
    }),
  } as unknown as RemoteApiClient;
  const error = await new RemoteReaderRepository(client)
    .saveReadingPosition({ novelId: 'book', ...position })
    .catch((error) => error);
  expect(error).toBeInstanceOf(ReadingPositionSaveError);
  expect(error.reason).toBe(reason);
  expect(error.message).toContain(`HTTP ${status}`);
  expect(error.message).not.toContain('private upstream payload');
});
it('preserves a real newer-position conflict without disguising it as connectivity failure', async () => {
  const client = {
    saveReadingPosition: vi.fn(async () => ({ ok: true, applied: false })),
  } as unknown as RemoteApiClient;
  await expect(
    new RemoteReaderRepository(client).saveReadingPosition({ novelId: 'book', ...position }),
  ).rejects.toBeInstanceOf(RemoteMutationConflictError);
});

it('forwards a pinned content revision through the repository and reports a typed conflict without retry', async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ error: 'content_revision_conflict' }), { status: 409 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    new RemoteReaderRepository(new RemoteApiClient('/api')).saveReadingPosition({ novelId: 'book', ...position }),
  ).rejects.toMatchObject({ name: 'ReadingPositionSaveError', reason: 'conflict', status: 409 });
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({ expectedContentRevisionId: 'revision_old' });
});

it('does not label same-timestamp replay conflicts as a changed content revision', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'Conflict', message: 'same timestamp, different payload' }), {
        status: 409,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    new RemoteReaderRepository(new RemoteApiClient('/api')).saveReadingPosition({ novelId: 'book', ...position }),
  ).rejects.toMatchObject({ name: 'ReadingPositionSaveError', reason: 'response', status: 409 });
  expect(fetch).toHaveBeenCalledOnce();
});
