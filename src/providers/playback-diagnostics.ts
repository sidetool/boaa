/** Local, bounded observations. No text, URLs, identifiers, audio or automatic upload. */
type Fields = Readonly<Record<string, number | boolean | undefined>>;
type EventName =
  | 'session'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'runner-end'
  | 'chapter-open'
  | 'wait-start'
  | 'wait-end'
  | 'wait-error'
  | 'source'
  | 'play-call'
  | 'play-resolved'
  | 'play-rejected'
  | 'recovery'
  | 'playing'
  | 'waiting'
  | 'media-pause'
  | 'ended'
  | 'media-error'
  | 'sample'
  | 'media-finish'
  | 'hidden'
  | 'visible'
  | 'freeze'
  | 'thaw'
  | 'pageshow'
  | 'pagehide'
  | 'media-snapshot';
interface Entry {
  ms: number;
  event: EventName;
  hidden: boolean;
  values: Record<string, number | boolean>;
}
const LIMIT = 256;

export class PlaybackDiagnostics {
  private entries: Entry[] = [];
  private wake: Entry[] = [];
  private started?: number;
  private sequence = 0;
  private media = new Set<() => Fields>();
  constructor(
    private readonly now = () => Date.now(),
    private readonly hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  ) {}

  nextId(): number {
    return ++this.sequence;
  }

  start(values: Fields): void {
    this.started ??= this.now();
    this.record('session', values);
  }

  record(event: EventName, values: Fields = {}): void {
    if (this.started === undefined) return;
    // Runtime filtering also protects against accidental error objects/strings in future callers.
    const safe: Entry['values'] = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'boolean') safe[key] = value;
      else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = Math.round(value * 1000) / 1000;
    }
    this.entries.push({ ms: this.now() - this.started, event, hidden: this.hidden(), values: safe });
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
  }

  observeMedia(snapshot: () => Fields): () => void {
    this.media.add(snapshot);
    return () => this.media.delete(snapshot);
  }

  lifecycle(event: 'hidden' | 'visible' | 'freeze' | 'thaw' | 'pageshow' | 'pagehide'): void {
    const state = typeof navigator === 'undefined' ? undefined : navigator.mediaSession?.playbackState;
    this.record(event, {
      activeMedia: this.media.size,
      mediaSession: state === 'playing' ? 1 : state === 'paused' ? 2 : 0,
      online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
    });
    for (const snapshot of this.media) {
      try {
        this.record('media-snapshot', snapshot());
      } catch {
        /* Diagnostics cannot interrupt playback. */
      }
    }
    // Capture in the document's capture phase, before visibility-triggered media recovery.
    // Keep this snapshot even when subsequent playback overwrites the rolling event buffer.
    if (event === 'visible' || event === 'thaw') this.wake = this.entries.slice();
  }

  report(): string | undefined {
    if (this.started === undefined) return;
    return JSON.stringify({ format: 'boaa-playback-20261030-1', beforeWake: this.wake, recent: this.entries });
  }
}

export const playbackDiagnostics = new PlaybackDiagnostics();
let listening = false;
export function startPlaybackDiagnostics(values: Fields): void {
  playbackDiagnostics.start(values);
  if (listening || typeof document === 'undefined' || typeof window === 'undefined') return;
  listening = true;
  document.addEventListener(
    'visibilitychange',
    () => playbackDiagnostics.lifecycle(document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
    true,
  );
  document.addEventListener('freeze', () => playbackDiagnostics.lifecycle('freeze'), true);
  document.addEventListener('resume', () => playbackDiagnostics.lifecycle('thaw'), true);
  window.addEventListener('pageshow', () => playbackDiagnostics.lifecycle('pageshow'), true);
  window.addEventListener('pagehide', () => playbackDiagnostics.lifecycle('pagehide'), true);
}

const stages = { paragraph: 1, manifest: 2, savedAudio: 3, buffer: 4, chapter: 5, gap: 6, resolve: 7 } as const;
export async function tracePlaybackWait<T>(
  stage: keyof typeof stages,
  operation: () => Promise<T>,
  values: Fields = {},
): Promise<T> {
  const op = playbackDiagnostics.nextId();
  playbackDiagnostics.record('wait-start', { ...values, stage: stages[stage], op });
  try {
    const result = await operation();
    playbackDiagnostics.record('wait-end', { stage: stages[stage], op });
    return result;
  } catch (error) {
    playbackDiagnostics.record('wait-error', {
      stage: stages[stage],
      op,
      status: (error as { status?: number } | null)?.status,
      aborted: (error as { name?: string } | null)?.name === 'AbortError',
    });
    throw error;
  }
}
