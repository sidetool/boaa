import type { SpeakerEngine, SpeakerEngineDiscovery, SpeakerEnginesPort } from '../../providers/speaker-engine';
import type {
  SpeakerCleanupPreview,
  SpeakerCleanupResult,
  SpeakerGenerationPort,
  SpeakerGenerationJob,
  SpeakerGenerationEstimate,
  SpeakerGenerationPreferences,
  SpeakerRevoiceSource,
  SpeakerRevoiceEstimate,
} from '../../providers/speaker-generation';
import type { RemoteApiClient } from './remote-api-client';
import type { VoiceLibraryPort, LibraryVoice, BookVoiceAssignment } from '../../providers/voice-library';

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
    castings: async (id, signal) =>
      (await client.request<{ assignments: BookVoiceAssignment[] }>(item(id) + '/castings', { signal })).assignments,
    assign: async (id, speakerId, voiceId, signal) => {
      await send(client, item(id) + '/castings', 'PUT', { speakerId, voiceId }, signal);
    },
    previewCleanup: async (options, signal) => {
      await writes;
      return send<SpeakerCleanupPreview>(client, base + '/cleanup/preview', 'POST', options, signal);
    },
    cleanup: (options, fingerprint, confirm, signal) => {
      const task = writes.then(() =>
        send<SpeakerCleanupResult>(client, base + '/cleanup', 'POST', { ...options, fingerprint, confirm }, signal),
      );
      writes = task.catch(() => undefined);
      return task;
    },
    revoiceSource: (id, signal) => client.request<SpeakerRevoiceSource>(item(id) + '/revoice', { signal }, 30000, true),
    estimateRevoice: (id, input, signal) =>
      send<SpeakerRevoiceEstimate>(client, item(id) + '/revoice/estimate', 'POST', input, signal),
    revoice: (id, input, fingerprint, confirmPaid, signal) =>
      send<SpeakerGenerationJob>(client, item(id) + '/revoice', 'POST', { ...input, fingerprint, confirmPaid }, signal),
  };
}
export function createVoiceLibraryPort(client: RemoteApiClient): VoiceLibraryPort {
  const base = '/tts/voice-library',
    item = (id: string) => base + '/' + encodeURIComponent(id);
  return {
    list: (signal) => client.request(base, { signal }),
    save: (input, signal, id) => send<LibraryVoice>(client, id ? item(id) : base, id ? 'PUT' : 'POST', input, signal),
    remove: async (id, signal) => {
      await client.request(item(id), { method: 'DELETE', signal });
    },
    design: (input, signal) =>
      client.request<LibraryVoice>(
        base + '/design',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal },
        150000,
      ),
    sample: async (id, signal) =>
      (await client.requestBlob(item(id) + '/sample', { method: 'POST', signal }, 60000, undefined, undefined, true))
        .blob,
  };
}
