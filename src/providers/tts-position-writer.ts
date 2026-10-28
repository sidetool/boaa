/** Best-effort cursor writes stay ordered and bounded without holding up audio. */
export function createTTSPositionWriter() {
  let pending: (() => Promise<void>) | undefined;
  let running = false;
  let closed = false;
  const drain = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed && pending) {
        const task = pending;
        pending = undefined;
        try {
          await task();
        } catch {
          /* A cursor failure must not stop narration. */
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    enqueue(task: () => Promise<void>) {
      if (closed) return;
      pending = task;
      void drain();
    },
    close() {
      closed = true;
      pending = undefined;
    },
  };
}
