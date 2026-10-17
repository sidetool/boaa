import { expect, it, vi } from 'vitest';
import { RemoteBookTransport } from './remote-book-transport';
import type { RemoteRequest } from './remote-api-contracts';
it('shares concurrent manifests and chapters but never retains a settled revision', async () => {
  const request = vi.fn(async () => ({ book: {}, chapters: [] }));
  const transport = new RemoteBookTransport(request as RemoteRequest);
  await Promise.all([
    transport.getBookManifest('book'),
    transport.getBookManifest('book'),
    transport.listChapters('book'),
    transport.listChapters('book'),
  ]);
  expect(request).toHaveBeenCalledTimes(2);
  await transport.getBookManifest('book');
  expect(request).toHaveBeenCalledTimes(3);
});
it('isolates cancellation and releases failed requests for retry', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ book: {} });
  const transport = new RemoteBookTransport(request as RemoteRequest);
  await expect(transport.getBookManifest('book')).rejects.toThrow('offline');
  await transport.getBookManifest('book');
  const a = new AbortController(),
    b = new AbortController();
  await Promise.all([
    transport.getBookManifest('book', undefined, a.signal),
    transport.getBookManifest('book', undefined, b.signal),
  ]);
  expect(request).toHaveBeenCalledTimes(4);
});
