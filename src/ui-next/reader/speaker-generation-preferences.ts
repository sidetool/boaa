import type { SpeakerGenerationPort, SpeakerGenerationPreferences } from '../../providers/speaker-generation';

type Listener = (error: unknown) => void;

/**
 * Saved model and voice choices for one port (one account and book). Saves run one at a time, a burst of changes
 * sends only the newest, and a save started before the page closed still finishes. Only live pages listen for
 * failures, so nothing updates a page that is gone.
 */
export interface SpeakerPreferenceQueue {
  /** The newest value asked for during this app session, saved or still on its way. */
  readonly latest: SpeakerGenerationPreferences | undefined;
  readonly port: SpeakerGenerationPort;
  save(value: SpeakerGenerationPreferences): void;
  /** Resolves once every save asked for so far has been sent (or failed). */
  idle(): Promise<void>;
  /** The server replaced the saved value (cleanup): take it as both the newest and the last sent. */
  replace(value: SpeakerGenerationPreferences | undefined): void;
  onError(listener: Listener): () => void;
}

const queues = new WeakMap<SpeakerGenerationPort, SpeakerPreferenceQueue>();

const same = (a?: SpeakerGenerationPreferences, b?: SpeakerGenerationPreferences) =>
  Boolean(
    a &&
    b &&
    a.engineId === b.engineId &&
    a.narratorVoiceId === b.narratorVoiceId &&
    a.autoActing === b.autoActing &&
    a.actingMode === b.actingMode &&
    a.actingEngineId === b.actingEngineId &&
    a.batchAudio === b.batchAudio &&
    JSON.stringify(a.casting) === JSON.stringify(b.casting) &&
    a.characterVoiceIds.length === b.characterVoiceIds.length &&
    a.characterVoiceIds.every((id, index) => id === b.characterVoiceIds[index]),
  );

export function speakerPreferenceQueue(port: SpeakerGenerationPort): SpeakerPreferenceQueue {
  const existing = queues.get(port);
  if (existing) return existing;
  let latest: SpeakerGenerationPreferences | undefined;
  let waiting: SpeakerGenerationPreferences | undefined;
  let sent: SpeakerGenerationPreferences | undefined;
  let running = false;
  let drained: Promise<void> = Promise.resolve();
  const listeners = new Set<Listener>();

  const drain = async () => {
    running = true;
    while (waiting) {
      const value = waiting;
      waiting = undefined;
      if (same(value, sent)) continue;
      try {
        await port.savePreferences(value);
        sent = value;
      } catch (error) {
        for (const listener of listeners) listener(error);
      }
    }
    running = false;
  };

  const queue: SpeakerPreferenceQueue = {
    get latest() {
      return latest;
    },
    port,
    save(value) {
      latest = {
        ...value,
        characterVoiceIds: [...value.characterVoiceIds],
        casting: value.casting ? { ...value.casting } : undefined,
      };
      waiting = latest;
      if (!running) drained = drain();
    },
    idle() {
      return drained;
    },
    replace(value) {
      latest = value && { ...value, characterVoiceIds: [...value.characterVoiceIds] };
      waiting = undefined;
      sent = latest;
    },
    onError(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  queues.set(port, queue);
  return queue;
}
