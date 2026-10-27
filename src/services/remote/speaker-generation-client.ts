import type { SpeakerEngine, SpeakerEngineDiscovery, SpeakerEnginesPort } from '../../providers/speaker-engine';
import type {
  SpeakerGenerationPort,
  SpeakerGenerationJob,
  SpeakerGenerationEstimate,
  SpeakerGenerationPreferences,
} from '../../providers/speaker-generation';
import type { RemoteApiClient } from './remote-api-client';

function send<T>(client: RemoteApiClient, url: string, method: string, body: unknown, signal?: AbortSignal) {
  return client.request<T>(
    url,
    { method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    35000,
  );
}
export function createSpeakerEnginesPort(client: RemoteApiClient): SpeakerEnginesPort {
  const item = (id?: string) => '/tts/speaker-engines' + (id ? '/' + encodeURIComponent(id) : '');
  return {
    list: async (signal) => (await client.request<{ engines: SpeakerEngine[] }>(item(), { signal })).engines,
    probe: (input, signal, id) => send<SpeakerEngineDiscovery>(client, item(id) + '/probe', 'POST', input, signal),
    save: (input, signal, id) => send<SpeakerEngine>(client, item(id), id ? 'PUT' : 'POST', input, signal),
    remove: async (id, signal) => {
      await client.request(item(id), { method: 'DELETE', signal });
    },
  };
}
export function createSpeakerGenerationPort(client: RemoteApiClient, bookId: string): SpeakerGenerationPort {
  const base = '/books/' + encodeURIComponent(bookId) + '/speaker-generation';
  const item = (id: string) => base + '/' + encodeURIComponent(id);
  let writes: Promise<unknown> = Promise.resolve();
  return {
    preferences: async (signal) => {
      await writes;
      return (await client.request<{ preferences?: SpeakerGenerationPreferences }>(base + '/preferences', { signal }))
        .preferences;
    },
    savePreferences: async (value, signal) => {
      const task = writes.then(() => send(client, base + '/preferences', 'PUT', value, signal));
      writes = task.catch(() => undefined);
      await task;
    },
    list: async (signal) => (await client.request<{ jobs: SpeakerGenerationJob[] }>(base, { signal })).jobs,
    estimate: (input, signal) => send<SpeakerGenerationEstimate>(client, base + '/estimate', 'POST', input, signal),
    create: (input, fingerprint, confirmPaid, signal) =>
      send<SpeakerGenerationJob>(client, base, 'POST', { ...input, fingerprint, confirmPaid }, signal),
    control: (id, action, confirmPaid = false) =>
      send<SpeakerGenerationJob>(client, item(id) + '/control', 'POST', { action, confirmPaid }),
    remove: async (id) => {
      await client.request(item(id), { method: 'DELETE' });
    },
  };
}
