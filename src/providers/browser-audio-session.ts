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
  onPlaying?: (playing: boolean) => void;
  cleanup?: () => void;
}

export class BrowserAudioSession {
  private active?: ActiveBrowserAudio;
  private audio?: BrowserAudioElement;
  private volume = 1;
  private playbackRate = 1;

  constructor(
    private readonly dependencies: BrowserAudioSessionDependencies = createDefaultBrowserAudioSessionDependencies(),
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
      };
      this.active = active;
      audio.onended = () => {
        // The reused element can dispatch an old queued event after its source changes.
        if (this.active !== active || audio.ended === false) return;
        this.finish(active, true);
      };
      audio.onerror = () => this.finish(active, false);
      const inspect = (recover = true) => {
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
          onPlaying?.(true);
        } else if (recover && Date.now() - active.lastProgress >= 15_000) {
          if (active.recoveries >= 2) this.finish(active, false, true);
          else {
            active.recoveries++;
            active.lastProgress = Date.now();
            void this.resume().then((ok) => {
              if (!ok && this.active === active) this.finish(active, false, true);
            });
          }
        }
      };
      audio.onplaying = () => {
        if (this.active === active && !active.userPaused) onPlaying?.(true);
      };
      audio.onwaiting = () => {
        if (this.active === active) onPlaying?.(false);
      };
      audio.onpause = () => {
        if (this.active !== active || active.userPaused || audio.paused !== true) return;
        onPlaying?.(false);
        // Native interruptions can pause an otherwise-live chunk without rejecting play().
        active.lastProgress = Math.min(active.lastProgress, Date.now() - 15_000);
        inspect();
      };
      const timer = globalThis.setInterval(inspect, 1_000);
      const wake = () => inspect();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
      if (typeof window !== 'undefined') window.addEventListener('pageshow', wake);
      active.cleanup = () => {
        globalThis.clearInterval(timer);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
        if (typeof window !== 'undefined') window.removeEventListener('pageshow', wake);
      };
      audio.ontimeupdate = () => {
        inspect(false);
        if (this.active !== active || active.settled || !Number.isFinite(audio.duration) || !audio.duration) return;
        onProgress?.(Math.max(0, Math.min(1, (audio.currentTime ?? 0) / audio.duration)));
      };
      try {
        void audio.play().then(
          () => {
            if (this.active === active && !active.userPaused && audio.paused !== true) onPlaying?.(true);
          },
          () => {
            if (this.active === active && !active.userPaused) this.finish(active, false, true);
          },
        );
      } catch {
        this.finish(active, false);
      }
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
    const audio = active.audio;
    active.userPaused = false;
    active.lastProgress = Date.now();
    try {
      await audio.play();
      if (this.active === active && !active.userPaused) active.onPlaying?.(true);
      return true;
    } catch {
      return this.active !== active || active.userPaused;
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
}

function createDefaultBrowserAudioSessionDependencies(): BrowserAudioSessionDependencies {
  return {
    createAudio: (url) => new Audio(url),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}
