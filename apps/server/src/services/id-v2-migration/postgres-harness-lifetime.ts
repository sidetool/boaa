// Vitest timing out a test does not cancel its Promise. Keep the temporary
// database alive until every admitted schema callback has also finished cleanup.
export class PostgresHarnessLifetime {
  private readonly pending = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('PostgreSQL test harness is stopping.'));
    const result = Promise.resolve().then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }

  stop(dispose: () => Promise<void>): Promise<void> {
    this.stopping ??= Promise.all([...this.pending]).then(dispose);
    return this.stopping;
  }
}
