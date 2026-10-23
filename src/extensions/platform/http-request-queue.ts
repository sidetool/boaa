interface Pending {
  owner: string;
  start(): void;
}

/** Share the server's per-owner network budget across home, controllers and views. */
export class PluginHttpRequestQueue {
  private active = new Map<string, number>();
  private total = 0;
  private waiting: Pending[] = [];

  run<T>(owner: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.waiting.length >= 64 || this.waiting.filter((entry) => entry.owner === owner).length >= 32)
      return Promise.reject(Error('HTTP_REQUEST_LIMIT'));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.waiting = this.waiting.filter((entry) => entry !== pending);
        signal.removeEventListener('abort', cancel);
        reject(signal.reason ?? Error('HTTP_CANCELLED'));
        this.pump();
      };
      const pending: Pending = {
        owner,
        start: () => {
          signal.removeEventListener('abort', cancel);
          this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
          this.total++;
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return task();
            })
            .then(resolve, reject)
            .finally(() => {
              const remaining = this.active.get(owner)! - 1;
              if (remaining) this.active.set(owner, remaining);
              else this.active.delete(owner);
              this.total--;
              this.pump();
            });
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.waiting.push(pending);
      this.pump();
    });
  }

  private pump() {
    while (this.total < 12) {
      const index = this.waiting.findIndex((entry) => (this.active.get(entry.owner) ?? 0) < 4);
      if (index < 0) return;
      this.waiting.splice(index, 1)[0]!.start();
    }
  }
}
