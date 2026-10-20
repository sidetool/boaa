/** Bounded, in-memory audio owned by one reader/account/content session. */
export class PlainTTSSessionCache {
  private entries = new Map<
    string,
    {
      scope: string;
      chapter: string;
      positions: readonly number[];
      controller: AbortController;
      promise: Promise<Blob>;
      blob?: Blob;
    }
  >();

  constructor(
    private readonly maxEntries = 8,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  getOrCreate(input: {
    key: string;
    scope: string;
    chapter: string;
    positions: readonly number[];
    fetch(signal: AbortSignal): Promise<Blob>;
  }): Promise<Blob> {
    const existing = this.entries.get(input.key);
    if (existing) {
      this.entries.delete(input.key);
      this.entries.set(input.key, existing);
      return existing.promise;
    }
    const controller = new AbortController();
    const entry = { ...input, controller, blob: undefined as Blob | undefined, promise: undefined! as Promise<Blob> };
    entry.promise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        return input.fetch(controller.signal);
      })
      .then(
        (blob) => {
          if (this.entries.get(input.key) === entry) {
            entry.blob = blob;
            this.trim();
          }
          return blob;
        },
        (error: unknown) => {
          if (this.entries.get(input.key) === entry) this.entries.delete(input.key);
          throw error;
        },
      );
    this.entries.set(input.key, entry);
    this.trim();
    return entry.promise;
  }

  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + (entry.blob?.size ?? 0), 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && bytes <= this.maxBytes) break;
      // Evict completed audio first; don't cancel a shared paid request merely to seek.
      if (!entry.blob) continue;
      bytes -= entry.blob.size;
      this.entries.delete(key);
    }
    // Bound even rapid navigation while synthesis is pending.
    while (this.entries.size > this.maxEntries) {
      const key = this.entries.keys().next().value!;
      this.entries.get(key)!.controller.abort();
      this.entries.delete(key);
    }
  }

  batch(scope: string, chapter: string, index: number): readonly number[] | undefined {
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.scope === scope && entry.chapter === chapter && entry.positions.includes(index)) return entry.positions;
    }
  }

  clear() {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }
}

/** Cancelling playback detaches a listener, not the shared synthesis request. */
export function waitForPlainTTSAudio(promise: Promise<Blob>, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
