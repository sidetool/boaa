export type ReaderOrientation = 'portrait' | 'landscape' | undefined;

/** Saved preference survives reader exits; only the active reader owns the device lock. */
export class ReaderOrientationLock {
  private orientation: ReaderOrientation;
  private active = false;
  private generation = 0;
  private pending = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly lock: (orientation: 'portrait' | 'landscape') => Promise<void>,
    private readonly unlock: () => void,
    private readonly preference: { read(): ReaderOrientation; write(value: ReaderOrientation): void },
  ) {
    try {
      this.orientation = preference.read();
    } catch {
      // Device storage can be blocked without disabling session controls.
    }
  }

  readonly snapshot = () => this.orientation;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setOrientation(orientation: ReaderOrientation): Promise<void> {
    this.orientation = orientation;
    try {
      this.preference.write(orientation);
    } catch {
      /* Keep the session preference. */
    }
    for (const listener of this.listeners) listener();
    return this.apply();
  }

  setActive(active: boolean): void {
    this.active = active;
    void this.apply();
  }

  readonly reapply = () => {
    if (this.active) void this.apply();
  };

  private apply(): Promise<void> {
    const generation = ++this.generation;
    // Serialize native calls: a late lock must not override a newer selection or reader exit.
    this.pending = this.pending.then(async () => {
      if (generation !== this.generation) return;
      try {
        if (this.active && this.orientation) await this.lock(this.orientation);
        else this.unlock();
      } catch {
        // Some browsers require fullscreen. Keep the preference for the next supported attempt.
      }
    });
    return this.pending;
  }
}
