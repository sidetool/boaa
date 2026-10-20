export interface BrowserAudioElement {
  src: string;
  onended: HTMLAudioElement['onended'];
  onerror: HTMLAudioElement['onerror'];
  ontimeupdate?: HTMLAudioElement['ontimeupdate'];
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

  async playBlob(blob: Blob, onProgress?: (fraction: number) => void): Promise<boolean> {
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
      const active: ActiveBrowserAudio = { audio, url, resolve, settled: false };
      this.active = active;
      audio.onended = () => {
        // The reused element can dispatch an old queued event after its source changes.
        if (this.active !== active || audio.ended === false) return;
        this.finish(active, true);
      };
      audio.onerror = () => this.finish(active, false);
      audio.ontimeupdate = () => {
        if (this.active !== active || active.settled || !Number.isFinite(audio.duration) || !audio.duration) return;
        onProgress?.(Math.max(0, Math.min(1, (audio.currentTime ?? 0) / audio.duration)));
      };
      try {
        void audio.play().catch(() => this.finish(active, false));
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
    this.active?.audio.pause();
  }

  async resume(): Promise<boolean> {
    const audio = this.active?.audio;
    if (!audio) return false;
    try {
      await audio.play();
      return true;
    } catch {
      return false;
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
    active.audio.onended = null;
    active.audio.onerror = null;
    active.audio.ontimeupdate = null;
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
