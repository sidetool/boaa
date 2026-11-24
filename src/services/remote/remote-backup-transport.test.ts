import { afterEach, expect, it, vi } from 'vitest';
import { RemoteApiClient } from './remote-api-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps staged restore authenticated and does not replay the mutation when progress polling fails', async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Promise.resolve(new Response('telemetry unavailable', { status: 503 }));
  });
  vi.stubGlobal('fetch', fetch);
  const progress = vi.fn();
  const client = new RemoteApiClient('https://fixture.invalid/api', { getAuthToken: () => 'fixture-token' });
  const pending = client.restoreInspectedBackup(
    'stage/1',
    { defaultConflictResolution: 'skip', conflictResolutions: { book: 'replace' } },
    progress,
  );
  await vi.advanceTimersByTimeAsync(1800);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(fetch.mock.calls[0]).toEqual([
    expect.stringMatching(/^https:\/\/fixture\.invalid\/api\/backups\/staged\/stage%2F1\/restore\?progressId=/),
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-token',
        'X-Backup-Default-Resolution': 'skip',
        'X-Backup-Conflict-Resolutions': '{"book":"replace"}',
      }),
    }),
  ]);
  finish(Response.json({ restoredBooks: 1 }));
  await expect(pending).resolves.toEqual({ restoredBooks: 1 });
  const requests = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(progress).not.toHaveBeenCalled();
});

it('keeps failed restore results uncertain without a retry and rejects malformed download tickets', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('connection interrupted'))
    .mockResolvedValueOnce(Response.json({ ticket: '../outside' }));
  vi.stubGlobal('fetch', fetch);
  const client = new RemoteApiClient('https://fixture.invalid/api');
  const archive = new Blob(['archive']);
  await expect(client.restoreBackup(archive, { defaultConflictResolution: 'skip' })).rejects.toThrow(
    'connection interrupted',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: archive }));
  await expect(client.createBackupDownload()).rejects.toThrow('다운로드 주소를 확인하지 못했습니다.');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('stages an uninspected ZIP once and sends large reviewed selections in the JSON body', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ stagedId: 'stage' }))
    .mockResolvedValueOnce(Response.json({ restoredBooks: 500 }));
  vi.stubGlobal('fetch', fetch);
  const client = new RemoteApiClient('https://fixture.invalid/api');
  const archive = new Blob(['archive']);
  const options = {
    defaultConflictResolution: 'skip' as const,
    conflictResolutions: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`book_${i}`, 'replace'] as const)),
  };
  await expect(client.restoreBackup(archive, options)).resolves.toEqual({ restoredBooks: 500 });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://fixture.invalid/api/backups/inspect',
    'https://fixture.invalid/api/backups/staged/stage/restore',
  ]);
  expect(fetch.mock.calls[0][1].body).toBe(archive);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(options);
  expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('X-Backup-Conflict-Resolutions');
});
