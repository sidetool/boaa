import type { AudiobookEstimate, AudiobookPort, SavedAudiobook } from '../../providers/plain-audiobook';
import type { RemoteApiClient } from './remote-api-client';

export function createAudiobookPort(client: RemoteApiClient, bookId: string): AudiobookPort {
  const path = `/books/${encodeURIComponent(bookId)}/audiobooks`;
  const item = (id: string) => `/audiobooks/${encodeURIComponent(id)}`;
  // The port survives closing/reopening the page. Finish its older position write first,
  // including one already in flight when the previous playback component unmounted.
  let positions: Promise<unknown> = Promise.resolve();
  const post = <T>(url: string, body: unknown, signal?: AbortSignal) =>
    client.request<T>(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
      120_000,
    );
  return {
    list: async (signal) => (await client.request<{ audiobooks: SavedAudiobook[] }>(path, { signal })).audiobooks,
    estimate: (input, signal) => post<AudiobookEstimate>(`${path}/estimate`, input, signal),
    create: (input, fingerprint, confirmPaid, signal) =>
      post<SavedAudiobook>(path, { ...input, fingerprint, confirmPaid }, signal),
    control: (id, action, confirmPaid = false) => post<SavedAudiobook>(`${item(id)}/control`, { action, confirmPaid }),
    remove: async (id) => {
      await client.request(item(id), { method: 'DELETE' });
    },
    audio: async (id, index, signal) =>
      (await client.requestBlob(`${item(id)}/audio/${index}`, { signal }, 60_000)).blob,
    progress: async (id, index) => {
      const write = positions.then(() => post(`${item(id)}/progress`, { index }));
      positions = write.catch(() => undefined);
      await write;
    },
  };
}
