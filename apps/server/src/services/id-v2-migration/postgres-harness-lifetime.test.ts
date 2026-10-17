import { describe, expect, it, vi } from 'vitest';
import { PostgresHarnessLifetime } from './postgres-harness-lifetime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PostgreSQL harness shutdown', () => {
  it('waits for a timed-out caller’s continuing schema work and cleanup before disposing', async () => {
    const lifetime = new PostgresHarnessLifetime();
    const work = deferred();
    const cleanup = deferred();
    const events: string[] = [];
    const operation = lifetime.run(async () => {
      try {
        await work.promise;
        events.push('query finished');
      } finally {
        await cleanup.promise;
        events.push('schema and pools closed');
      }
    });
    // A test timeout returns control to afterAll while its async callback lives on.
    const stop = lifetime.stop(async () => {
      events.push('database stopped');
    });
    work.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['query finished']);
    cleanup.resolve();
    await Promise.all([operation, stop]);
    expect(events).toEqual(['query finished', 'schema and pools closed', 'database stopped']);
  });

  it('drains rejecting work, rejects new scopes and disposes only once', async () => {
    const lifetime = new PostgresHarnessLifetime();
    const cleanup = deferred();
    const failure = new Error('transaction failed');
    const operation = lifetime.run(async () => {
      try {
        throw failure;
      } finally {
        await cleanup.promise;
      }
    });
    const rejected = expect(operation).rejects.toBe(failure);
    const dispose = vi.fn(async () => {});
    const stop = lifetime.stop(dispose);
    const late = vi.fn(async () => {});
    await expect(lifetime.run(late)).rejects.toThrow('harness is stopping');
    expect(late).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(lifetime.stop(dispose)).toBe(stop);
    cleanup.resolve();
    await Promise.all([rejected, stop]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
