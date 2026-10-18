/** A bounded lazy pool. A lease covers response streaming, not just handler execution. */
export class OwnerRuntimeRegistry<T extends { close(): void | Promise<void> }> {
  private entries = new Map<
    string,
    { value: Promise<T>; active: number; touched: number; abort: AbortController; closing?: Promise<void> }
  >();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private readonly open: (userId: string) => Promise<T>,
    private readonly limit = 4,
    private readonly idleMs = 10 * 60_000,
  ) {
    this.timer = setInterval(
      () => {
        void this.prune().catch(() => {});
      },
      Math.min(idleMs, 60_000),
    );
    this.timer.unref();
  }
  async acquire(userId: string): Promise<{ value: T; signal: AbortSignal; release(): void }> {
    if (this.stopped) throw Object.assign(new Error('source_runtime_unavailable'), { statusCode: 503 });
    let entry = this.entries.get(userId);
    if (entry?.closing) {
      await entry.closing;
      return this.acquire(userId);
    }
    if (!entry) {
      // Closing bundles retain their capacity permit until shutdown finishes.
      if (this.entries.size >= this.limit) {
        const idle = [...this.entries]
          .filter(([, e]) => !e.active && !e.closing)
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!idle) {
          const closing = [...this.entries.values()].flatMap((e) => (e.closing ? [e.closing] : []));
          if (closing.length) {
            await Promise.race(closing);
            return this.acquire(userId);
          }
          throw Object.assign(new Error('source_runtime_busy'), { statusCode: 429 });
        }
        await this.dispose(idle[0]);
        return this.acquire(userId);
      }
      const abort = new AbortController();
      entry = { value: Promise.resolve().then(() => this.open(userId)), active: 0, touched: Date.now(), abort };
      this.entries.set(userId, entry);
    }
    entry.active++;
    const current = entry;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        current.active--;
        current.touched = Date.now();
      }
    };
    try {
      const value = await current.value;
      current.abort.signal.throwIfAborted();
      return { value, signal: current.abort.signal, release };
    } catch (error) {
      release();
      if (!current.closing && this.entries.get(userId) === current) this.entries.delete(userId);
      throw error;
    }
  }
  async dispose(userId: string) {
    const entry = this.entries.get(userId);
    if (!entry) return;
    if (entry.closing) return entry.closing;
    entry.abort.abort(new Error('source_runtime_disabled'));
    entry.closing = entry.value
      .then(
        (value) => value.close(),
        () => {},
      )
      .finally(() => {
        if (this.entries.get(userId) === entry) this.entries.delete(userId);
      });
    await entry.closing;
  }
  private async prune() {
    await Promise.all(
      [...this.entries]
        .filter(([, e]) => !e.active && Date.now() - e.touched >= this.idleMs)
        .map(([id]) => this.dispose(id)),
    );
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.all([...this.entries.keys()].map((id) => this.dispose(id)));
  }
}
