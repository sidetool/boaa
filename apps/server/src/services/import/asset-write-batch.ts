interface AssetWriteBatchOptions<T> {
  maxCount: number;
  maxBytes: number;
  byteLength: (asset: T) => number;
  beforeWrite: (assets: readonly T[]) => Promise<void>;
  write: (asset: T) => Promise<void>;
  afterWrite?: () => Promise<void>;
}

/** Sequential producers retain a bounded batch; no writes outlive add/flush. */
export class AssetWriteBatch<T> {
  private pending: T[] = [];
  private pendingBytes = 0;

  constructor(private readonly options: AssetWriteBatchOptions<T>) {}

  async add(asset: T): Promise<void> {
    const bytes = this.options.byteLength(asset);
    if (this.pendingBytes + bytes > this.options.maxBytes) await this.flush();
    this.pending.push(asset);
    this.pendingBytes += bytes;
    // An individual oversized asset is written alone rather than retained with others.
    if (this.pending.length >= this.options.maxCount || this.pendingBytes >= this.options.maxBytes) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    await this.options.beforeWrite(batch);
    const outcomes = await Promise.allSettled(batch.map(async (asset) => this.options.write(asset)));
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    await this.options.afterWrite?.();
  }
}
