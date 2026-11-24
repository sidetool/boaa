type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function whileActive<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Downloads ahead of a single ordered consumer. Completed values count toward admission. */
export class OrderedDownloadQueue<T> {
  private readonly abort = new AbortController();
  private readonly entries = new Map<number, { bytes: number; result: Promise<Outcome<T>> }>();
  private next = 0;
  private consumed = 0;
  private failedAt = Infinity;
  private closed = false;
  private readonly cancel = () => this.close();

  constructor(
    private readonly options: {
      signal: AbortSignal;
      itemSignal?(index: number): AbortSignal;
      concurrency: number;
      maxBufferedBytes: number;
      count(): number;
      estimateBytes(index: number): number;
      download(index: number, signal: AbortSignal): Promise<T>;
      size(value: T): number;
    },
  ) {
    if (
      !Number.isInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 2 ||
      !Number.isFinite(options.maxBufferedBytes) ||
      options.maxBufferedBytes <= 0
    )
      throw new Error('Invalid download queue limits');
    options.signal.addEventListener('abort', this.cancel, { once: true });
    if (options.signal.aborted) this.close();
  }

  private pump(): void {
    if (this.closed) return;
    while (
      this.entries.size < this.options.concurrency &&
      this.next < this.options.count() &&
      this.next <= this.failedAt
    ) {
      const bytes = Math.max(1, this.options.estimateBytes(this.next));
      const buffered = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      // Always admit one oversized chapter to make progress. Unknown/inaccurate
      // lengths can overshoot by the already admitted requests, never the whole queue.
      if (this.entries.size && buffered + bytes > this.options.maxBufferedBytes) break;
      const index = this.next++;
      const entry = { bytes, result: undefined as unknown as Promise<Outcome<T>> };
      this.entries.set(index, entry);
      const item = this.options.itemSignal?.(index);
      const signal = item ? AbortSignal.any([this.abort.signal, item]) : this.abort.signal;
      entry.result = Promise.resolve().then(async (): Promise<Outcome<T>> => {
        try {
          signal.throwIfAborted();
          const value = await this.options.download(index, signal);
          signal.throwIfAborted();
          entry.bytes = this.options.size(value);
          return { ok: true, value };
        } catch (error) {
          if (!item?.aborted) this.failedAt = Math.min(this.failedAt, index);
          return { ok: false, error };
        }
      });
    }
  }

  async take(index: number): Promise<T> {
    this.abort.signal.throwIfAborted();
    if (index !== this.consumed || index >= this.options.count()) throw new Error('Invalid download queue order');
    this.pump();
    const entry = this.entries.get(index)!;
    const item = this.options.itemSignal?.(index);
    const signal = item ? AbortSignal.any([this.abort.signal, item]) : this.abort.signal;
    const result = await whileActive(entry.result, signal);
    signal.throwIfAborted();
    if (!result.ok) throw result.error;
    this.entries.delete(index);
    this.consumed++;
    // Fetch the next chapter while the caller verifies/commits this one.
    this.pump();
    return result.value;
  }

  /** Advance a cancelled episode that failed before delivery to the consumer. */
  async skip(index: number): Promise<void> {
    if (index !== this.consumed) return;
    const entry = this.entries.get(index);
    if (entry) {
      // A provider can ignore an item abort. Keep its slot until it settles, while
      // a whole-batch stop must still release the ordered consumer immediately.
      await whileActive(entry.result, this.abort.signal);
    }
    this.entries.delete(index);
    this.consumed++;
    this.next = Math.max(this.next, this.consumed);
    if (this.failedAt === index) this.failedAt = Infinity;
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.options.signal.removeEventListener('abort', this.cancel);
    this.abort.abort();
    this.entries.clear();
  }
}
