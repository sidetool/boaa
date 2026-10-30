import { playbackDiagnostics } from './playback-diagnostics';

export interface BrowserAudioElement {
  src: string;
  onended: HTMLAudioElement['onended'];
  onerror: HTMLAudioElement['onerror'];
  ontimeupdate?: HTMLAudioElement['ontimeupdate'];
  onplaying?: HTMLAudioElement['onplaying'];
  onpause?: HTMLAudioElement['onpause'];
  onwaiting?: HTMLAudioElement['onwaiting'];
  readonly paused?: boolean;
  readonly currentTime?: number;
  readonly duration?: number;
  readonly ended?: boolean;
  readonly readyState?: number;
  readonly networkState?: number;
  readonly buffered?: Pick<TimeRanges, 'length' | 'start' | 'end'>;
  readonly error?: { code: number } | null;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  volume?: number;
  playbackRate?: number;
  defaultPlaybackRate?: number;
  preservesPitch?: boolean;
}

export interface BrowserAudioSessionDependencies {
  readonly createAudio: (url: string) => BrowserAudioElement;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
}

interface ActiveBrowserAudio {
  readonly audio: BrowserAudioElement;
  readonly url: string;
  readonly resolve: (played: boolean) => void;
  settled: boolean;
  userPaused: boolean;
  lastTime: number;
  lastProgress: number;
  recoveries: number;
  playAttempt?: object;
  restarting?: boolean;
  onPlaying?: (playing: boolean) => void;
  cleanup?: () => void;
  diagnosticId: number;
}

export class BrowserAudioSession {
  private active?: ActiveBrowserAudio;
  private audio?: BrowserAudioElement;
  private volume = 1;
  private playbackRate = 1;

  constructor(
    private readonly dependencies: BrowserAudioSessionDependencies = createDefaultBrowserAudioSessionDependencies(),
    private readonly diagnostics = false,
  ) {}

  get hasActivePlayback(): boolean {
    return this.active !== undefined;
  }

  async playBlob(
    blob: Blob,
    onProgress?: (fraction: number) => void,
    onPlaying?: (playing: boolean) => void,
  ): Promise<boolean> {
    if (this.active) this.stop(true);
    let url: string | undefined;
    let audio: BrowserAudioElement;
    try {
      url = this.dependencies.createObjectUrl(blob);
      // Keep the media element (and its playback permission) across sentences.
      // Replacing it for every blob can turn background continuation into a new autoplay.
      audio = this.audio ??= this.dependencies.createAudio(url);
      audio.src = url;
      audio.volume = this.volume;
      audio.defaultPlaybackRate = this.playbackRate;
      audio.playbackRate = this.playbackRate;
      audio.preservesPitch = true;
    } catch {
      if (url) this.revoke(url);
      return false;
    }

    return new Promise((resolve) => {
      const active: ActiveBrowserAudio = {
        audio,
        url,
        resolve,
        settled: false,
        userPaused: false,
        lastTime: 0,
        lastProgress: Date.now(),
        recoveries: 0,
        onPlaying,
        diagnosticId: playbackDiagnostics.nextId(),
      };
      this.active = active;
      this.record('source', active);
      const unobserve = this.diagnostics ? playbackDiagnostics.observeMedia(() => this.snapshot(active)) : undefined;
      let sampledAt = Date.now();
      audio.onended = () => {
        // The reused element can dispatch an old queued event after its source changes.
        if (this.active !== active || audio.ended === false) return;
        this.record('ended', active);
        this.finish(active, true);
      };
      audio.onerror = () => {
        this.record('media-error', active);
        this.finish(active, false);
      };
      const inspect = (recover = true, interrupted = false) => {
        if (Date.now() - sampledAt >= 5_000) {
          this.record('sample', active);
          sampledAt = Date.now();
        }
        if (this.active !== active || active.settled || active.userPaused) return;
        if (audio.ended === true) {
          this.finish(active, true);
          return;
        }
        const time = audio.currentTime ?? 0;
        if (time > active.lastTime) {
          active.lastTime = time;
          active.lastProgress = Date.now();
          active.recoveries = 0;
          // A missed background timeupdate does not mean a currently paused element is playing.
          if (audio.paused !== true) onPlaying?.(true);
        }
        if (audio.paused === true) onPlaying?.(false);
        if (recover && ((interrupted && audio.paused === true) || Date.now() - active.lastProgress >= 15_000)) {
          if (active.recoveries >= 2) this.finish(active, false, true);
          else {
            active.recoveries++;
            active.lastProgress = Date.now();
            onPlaying?.(false);
            // play() is a no-op for some stalled elements that still report paused=false.
            // Match manual pause/resume without loading a new source or losing the position.
            this.startPlay(active, true);
          }
        }
      };
      audio.onplaying = () => {
        this.record('playing', active);
        if (this.active === active && !active.userPaused) onPlaying?.(true);
      };
      audio.onwaiting = () => {
        this.record('waiting', active);
        if (this.active === active) onPlaying?.(false);
      };
      audio.onpause = () => {
        this.record('media-pause', active);
        if (this.active !== active || active.userPaused || active.restarting || audio.paused !== true) return;
        onPlaying?.(false);
        // Native interruptions can pause an otherwise-live chunk without rejecting play().
        active.lastProgress = Math.min(active.lastProgress, Date.now() - 15_000);
        inspect(true, true);
      };
      const timer = globalThis.setInterval(inspect, 1_000);
      const wake = () => inspect(true, true);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
      if (typeof window !== 'undefined') window.addEventListener('pageshow', wake);
      active.cleanup = () => {
        unobserve?.();
        globalThis.clearInterval(timer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
        if (typeof window !== 'undefined') window.removeEventListener('pageshow', wake);
      };
      audio.ontimeupdate = () => {
        inspect(false);
        if (this.active !== active || active.settled || !Number.isFinite(audio.duration) || !audio.duration) return;
        onProgress?.(Math.max(0, Math.min(1, (audio.currentTime ?? 0) / audio.duration)));
      };
      this.startPlay(active);
    });
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    if (this.active) this.active.audio.volume = this.volume;
  }

  setPlaybackRate(value: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2.5, Number.isFinite(value) ? value : 1));
    if (this.audio) {
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;
      this.audio.preservesPitch = true;
    }
  }

  pause(): void {
    if (this.active) {
      this.active.userPaused = true;
      this.active.onPlaying?.(false);
      this.active.audio.pause();
    }
  }

  async resume(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    active.userPaused = false;
    return this.play(active);
  }

  private startPlay(active: ActiveBrowserAudio, restart = false): void {
    const pending = this.play(active, restart);
    const attempt = active.playAttempt;
    void pending.then((ok) => {
      if (!ok && this.active === active && !active.userPaused && active.playAttempt === attempt)
        this.finish(active, false, true);
    });
  }

  private async play(active: ActiveBrowserAudio, restart = false): Promise<boolean> {
    const attempt = {};
    active.playAttempt = attempt;
    active.lastProgress = Date.now();
    this.record(restart ? 'recovery' : 'play-call', active);
    try {
      if (restart && active.audio.paused !== true) {
        active.restarting = true;
        try {
          active.audio.pause();
        } finally {
          active.restarting = false;
        }
      }
      await active.audio.play();
      this.record('play-resolved', active);
      if (
        this.active === active &&
        !active.userPaused &&
        active.playAttempt === attempt &&
        active.audio.paused !== true
      )
        active.onPlaying?.(true);
      return true;
    } catch (error) {
      this.record('play-rejected', active, {
        autoplay: (error as { name?: string } | null)?.name === 'NotAllowedError',
        aborted: (error as { name?: string } | null)?.name === 'AbortError',
      });
      // pause() can reject an older pending play() after a new attempt already started.
      return this.active !== active || active.userPaused || active.playAttempt !== attempt;
    }
  }

  stop(played = true): void {
    const active = this.active;
    if (active) this.finish(active, played, true);
    else if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  private finish(active: ActiveBrowserAudio, played: boolean, clearSource = false): void {
    if (active.settled) return;
    this.record('media-finish', active);
    active.settled = true;
    active.cleanup?.();
    active.onPlaying?.(false);
    active.audio.onended = null;
    active.audio.onerror = null;
    active.audio.ontimeupdate = null;
    active.audio.onplaying = null;
    active.audio.onpause = null;
    active.audio.onwaiting = null;
    if (clearSource) {
      active.audio.pause();
      active.audio.removeAttribute('src');
      active.audio.load();
    }
    if (this.active === active) this.active = undefined;
    this.revoke(active.url);
    active.resolve(played);
  }

  private revoke(url: string): void {
    try {
      this.dependencies.revokeObjectUrl(url);
    } catch {
      // Object URL cleanup must not turn playback completion into a user-visible TTS error.
    }
  }

  private snapshot(active: ActiveBrowserAudio) {
    const audio = active.audio;
    const buffered = audio.buffered;
    return {
      source: active.diagnosticId,
      current: this.active === active,
      time: audio.currentTime,
      duration: audio.duration,
      paused: audio.paused,
      ended: audio.ended,
      userPaused: active.userPaused,
      ready: audio.readyState,
      network: audio.networkState,
      rate: audio.playbackRate,
      error: audio.error?.code,
      bufferedEnd: buffered?.length ? buffered.end(buffered.length - 1) : undefined,
    };
  }

  private record(
    event: Parameters<typeof playbackDiagnostics.record>[0],
    active: ActiveBrowserAudio,
    values = {},
  ): void {
    if (!this.diagnostics) return;
    try {
      playbackDiagnostics.record(event, { ...this.snapshot(active), ...values });
    } catch {
      /* Observation only. */
    }
  }
}

function createDefaultBrowserAudioSessionDependencies(): BrowserAudioSessionDependencies {
  return {
    createAudio: (url) => new Audio(url),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}
