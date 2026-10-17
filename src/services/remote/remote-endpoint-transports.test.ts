import { afterEach, expect, it, vi } from 'vitest';
import { RemoteApiClient, RemoteApiRequestTimeoutError } from './remote-api-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps upload revision fences and binary chunks intact while refreshing authentication per call', async () => {
  let token = 'first';
  const fetcher = vi.fn(async () => json({ ok: true, uploadId: 'upload' }));
  vi.stubGlobal('fetch', fetcher);
  const client = new RemoteApiClient('/api', { getAuthToken: () => token });
  const input = {
    fileName: 'fixture.txt',
    sizeBytes: 3,
    contentType: 'text/plain',
    encoding: 'utf-8' as const,
    totalChunks: 1,
    expectedBase: { kind: 'revision' as const, contentRevisionId: 'revision-old' },
    baseActiveContentRevisionId: 'revision-old',
    sourceContentHash: 'sha256:fixture',
  };
  await client.initUpload(input);
  const first = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(first[0]).toBe('/api/uploads/init');
  expect(JSON.parse(first[1].body as string)).toEqual(input);
  expect(new Headers(first[1].headers).get('Authorization')).toBe('Bearer first');
  token = 'second';
  const chunk = new Blob(['raw']);
  await client.putUploadChunk('upload/a', 0, chunk);
  const second = fetcher.mock.calls[1] as unknown as [string, RequestInit];
  expect(second[0]).toBe('/api/uploads/upload%2Fa/chunks/0');
  expect(second[1].body).toBe(chunk);
  expect(new Headers(second[1].headers).get('Content-Type')).toBe('application/octet-stream');
  expect(new Headers(second[1].headers).get('Authorization')).toBe('Bearer second');
});

it.each(['upload', 'review', 'secret'] as const)(
  'does not retry a %s mutation rejected by the account boundary',
  async (kind) => {
    const fetcher = vi.fn(async () => json({ error: 'expired' }, 401));
    vi.stubGlobal('fetch', fetcher);
    const unauthorized = vi.fn();
    const client = new RemoteApiClient('/api', { onUnauthorized: unauthorized });
    const work =
      kind === 'upload'
        ? client.completeUpload('upload')
        : kind === 'review'
          ? client.approveAnalysisReviewArtifact('review', 7)
          : client.saveProviderSecret('tts_synthesis', 'provider', 'key', 'synthetic');
    await expect(work).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(unauthorized).toHaveBeenCalledOnce();
    if (kind === 'review')
      expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
        action: 'approve',
        expectedReviewRevision: 7,
      });
  },
);

it.each(['upload', 'provider'] as const)('retains caller cancellation for %s requests without retry', async (kind) => {
  const fetcher = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new RemoteApiClient('/api');
  const abort = new AbortController();
  const work =
    kind === 'upload' ? client.getUpload('upload', abort.signal) : client.getProviderJob('job', abort.signal);
  abort.abort();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps the standard request timeout around delegated provider requests', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new RemoteApiClient('/api', { requestTimeoutMs: 25 });
  const work = expect(client.getProviderJob('job')).rejects.toBeInstanceOf(RemoteApiRequestTimeoutError);
  await vi.advanceTimersByTimeAsync(25);
  await work;
  expect(fetcher).toHaveBeenCalledOnce();
});
