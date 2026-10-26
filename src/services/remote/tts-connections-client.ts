import type { TTSConnection, TTSConnectionDiscovery, TTSConnectionsPort } from '../../providers/tts-connections';
import type { RemoteApiClient } from './remote-api-client';

export function createTTSConnectionsPort(client: RemoteApiClient): TTSConnectionsPort {
  const base = '/tts/connections';
  const item = (id?: string) => base + (id ? '/' + encodeURIComponent(id) : '');
  const send = <T>(url: string, method: string, body: unknown, signal?: AbortSignal) =>
    client.request<T>(
      url,
      {
        method,
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      35_000,
    );
  return {
    list: async (signal) => (await client.request<{ connections: TTSConnection[] }>(base, { signal })).connections,
    probe: (input, signal, id) => send<TTSConnectionDiscovery>(item(id) + '/probe', 'POST', input, signal),
    save: (input, signal, id) => send<TTSConnection>(item(id), id ? 'PUT' : 'POST', input, signal),
    remove: async (id, signal) => {
      await client.request(item(id), { method: 'DELETE', signal });
    },
  };
}
