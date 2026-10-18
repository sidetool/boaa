export interface ReaderWakeLockSentinel {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void, options?: { once: boolean }): void;
}

/** User intent belongs to the reader, not the transient settings panel. */
export class ReaderWakeLock {
  private requested = false;
  private active = false;
  private generation = 0;
  private sentinel?: ReaderWakeLockSentinel;
  private pending?: Promise<void>;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly request: () => Promise<ReaderWakeLockSentinel>,
    private readonly visible: () => boolean,
  ) {}

  readonly snapshot = () => this.requested;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async toggle(): Promise<void> {
    this.requested = !this.requested;
    this.emit();
    if (!this.requested) this.release();
    else await this.reacquire();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.release();
    else void this.reacquire();
  }

  readonly visibilityChanged = (): void => {
    if (!this.visible()) this.release();
    else void this.reacquire();
  };

  dispose(): void {
    this.active = false;
    this.release();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private release(): void {
    this.generation += 1;
    this.pending = undefined;
    const sentinel = this.sentinel;
    this.sentinel = undefined;
    if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
  }

  private async reacquire(): Promise<void> {
    if (!this.active || !this.requested || !this.visible() || (this.sentinel && !this.sentinel.released)) return;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const sentinel = await this.request();
        if (generation !== this.generation || !this.active || !this.requested || !this.visible()) {
          await sentinel.release();
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener(
          'release',
          () => {
            if (this.sentinel === sentinel) this.sentinel = undefined;
            // Do not fight battery/OS revocation in a request loop. Retry on foreground/focus.
          },
          { once: true },
        );
      } catch {
        // Revocation or low battery is recoverable when the page becomes active again.
      }
    })();
    this.pending = pending;
    await pending;
    if (this.pending === pending) this.pending = undefined;
  }
}
