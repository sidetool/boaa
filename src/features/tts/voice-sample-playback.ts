import { BrowserAudioSession } from '../../providers/browser-audio-session';

/** A voice audition owns its pending synthesis and audio until it finishes or another sound takes over. */
export class VoiceSamplePlayback {
  private request?: AbortController;

  constructor(private readonly audio: Pick<BrowserAudioSession, 'playBlob' | 'stop'> = new BrowserAudioSession()) {}

  stop(): void {
    this.request?.abort();
    this.request = undefined;
    this.audio.stop(false);
  }

  async play(
    run: (signal: AbortSignal, playBlob: (blob: Blob) => Promise<boolean>) => Promise<boolean>,
  ): Promise<boolean> {
    this.stop();
    const request = new AbortController();
    this.request = request;
    // A submitted desktop synthesis command can keep running after cancellation.
    // Release its caller immediately and check ownership again before playing its output.
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(request.signal.reason);
      request.signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const playback = run(request.signal, (blob) => {
        request.signal.throwIfAborted();
        return this.audio.playBlob(blob);
      });
      return await Promise.race([cancelled, playback]);
    } finally {
      request.signal.removeEventListener('abort', cancel);
      if (this.request === request) this.request = undefined;
    }
  }
}
