import { useSyncExternalStore } from 'react';
import { BrowserAudioSession } from '../../providers/browser-audio-session';

/** What one preview button shows; `token` names the button (job, character and voice), not just the voice. */
export interface VoicePreviewState {
  token?: string;
  phase?: 'loading' | 'playing';
  error?: { token: string; message: string };
}
type Load = (voiceId: string, signal: AbortSignal) => Promise<Blob>;
type Entry = { promise: Promise<Blob>; controller: AbortController; waiters: number };
/** Samples are a few seconds each; a bounded session cache keeps browsing many voices from piling up. */
const CACHE_ENTRIES = 12;
const CACHE_BYTES = 6 * 1024 * 1024;

/**
 * One player for a whole page: a single audio element, so starting a sample stops any other, and a
 * session cache keyed by catalog/model revision so a changed connection never replays an old sample.
 * Requests run only from play(); a request nobody waits for any more is aborted, late replies are ignored.
 */
export function createVoicePreview(load: Load, before?: () => void | Promise<void>) {
  const audio = new BrowserAudioSession();
  const cache = new Map<string, Blob>();
  const pending = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let state: VoicePreviewState = {};
  let run: { token: string; abort: AbortController } | undefined;
  const set = (next: VoicePreviewState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  const remember = (key: string, blob: Blob) => {
    cache.delete(key);
    if (blob.size > CACHE_BYTES) return;
    cache.set(key, blob);
    let bytes = [...cache.values()].reduce((sum, b) => sum + b.size, 0);
    // Oldest first: Map keeps insertion order and a hit re-inserts its key.
    for (const [old, b] of cache) {
      if (cache.size <= CACHE_ENTRIES && bytes <= CACHE_BYTES) break;
      cache.delete(old);
      bytes -= b.size;
    }
  };
  /** Waits on what is already there (cached or in flight) without sending anything new. */
  const join = (key: string, signal: AbortSignal) => {
    const cached = cache.get(key);
    if (cached) {
      remember(key, cached);
      return { promise: Promise.resolve(cached), release: () => {} };
    }
    const shared = pending.get(key);
    if (!shared) return undefined;
    shared.waiters++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      shared.waiters--;
      // Nobody else is waiting for this sample: stop the request instead of paying for audio no one hears.
      if (shared.waiters === 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
    };
    signal.addEventListener('abort', release, { once: true });
    return { promise: shared.promise, release };
  };
  /** Sends the request; a synchronous throw becomes a rejection, and an unheard rejection is never unhandled. */
  const dispatch = (key: string, voiceId: string) => {
    const controller = new AbortController();
    let started: Promise<Blob>;
    try {
      started = load(voiceId, controller.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    const created: Entry = {
      controller,
      waiters: 0,
      promise: started.then(
        (blob) => {
          if (pending.get(key) === created) pending.delete(key);
          if (!controller.signal.aborted) remember(key, blob);
          return blob;
        },
        (error) => {
          if (pending.get(key) === created) pending.delete(key);
          throw error;
        },
      ),
    };
    created.promise.catch(() => {});
    pending.set(key, created);
  };
  const stop = (match?: (token: string) => boolean) => {
    if (!run || (match && !match(run.token))) return;
    const current = run;
    run = undefined;
    current.abort.abort();
    audio.stop(true);
    set({});
  };
  return {
    get state() {
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Plays `voiceId` for button `token`; pressing the playing button again stops it. */
    async play(token: string, key: string, voiceId: string) {
      if (run?.token === token) return stop();
      const abort = new AbortController();
      // Joined before the old button lets go, so the same voice pressed on another row shares its request.
      let request = join(key, abort.signal);
      stop();
      run = { token, abort };
      set({ token, phase: 'loading' });
      try {
        // A new request goes out only once the body narration has stopped.
        await before?.();
        if (abort.signal.aborted) return;
        if (!request) {
          if (!pending.has(key)) dispatch(key, voiceId);
          request = join(key, abort.signal)!;
        }
        const blob = await request.promise;
        request.release();
        if (abort.signal.aborted) return;
        set({ token, phase: 'playing' });
        const ok = await audio.playBlob(blob);
        if (abort.signal.aborted) return;
        if (!ok) throw new Error('미리듣기를 재생하지 못했어요.');
        run = undefined;
        set({});
      } catch (error) {
        if (abort.signal.aborted) return;
        run = undefined;
        set({
          error: {
            token,
            message:
              error instanceof Error && error.message && error.name !== 'AbortError'
                ? error.message
                : '미리듣기를 불러오지 못했어요.',
          },
        });
      } finally {
        // Failure or cancel: this button no longer holds a share of the request.
        request?.release();
      }
    },
    stop,
    /** The catalog or connection changed: stop what plays, drop requests and samples of the old one. */
    reset() {
      stop();
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
      cache.clear();
    },
    dispose() {
      this.reset();
      listeners.clear();
    },
  };
}
export type VoicePreview = ReturnType<typeof createVoicePreview>;

const idle = () => () => {};
const none: VoicePreviewState = {};
export function useVoicePreview(preview?: VoicePreview): VoicePreviewState {
  return useSyncExternalStore(
    preview ? preview.subscribe : idle,
    () => preview?.state ?? none,
    () => none,
  );
}
