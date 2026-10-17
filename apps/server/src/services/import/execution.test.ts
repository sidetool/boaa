import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertImportExecutionActive, startImportHeartbeat } from './execution.js';

afterEach(() => vi.useRealTimers());

describe('import execution ownership', () => {
  it.each([
    [{ status: 'cancelled', active_queue_job_id: 'current' }, 'cancelled'],
    [{ status: 'processing', cancel_requested_at: 'now', active_queue_job_id: 'current' }, 'cancelled'],
    [{ status: 'processing', active_queue_job_id: 'replacement' }, 'superseded'],
    [undefined, 'superseded'],
  ])('rejects a stopped or superseded execution: %j', async (row, reason) => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as unknown as pg.Pool;
    await expect(assertImportExecutionActive(pool, 'job', 'current')).rejects.toMatchObject({ reason });
  });

  it('aborts input work when a heartbeat loses its fence and releases its timer', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValue({ rowCount: 0 });
    const pool = { query } as unknown as pg.Pool;
    const abort = new AbortController();
    const stop = startImportHeartbeat(pool, 'job', abort, 'current');
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(abort.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(abort.signal.aborted).toBe(true);
    } finally {
      stop();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not turn a transient database failure into cancellation', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({ rowCount: 1 });
    const abort = new AbortController();
    const stop = startImportHeartbeat({ query } as unknown as pg.Pool, 'job', abort, 'current');
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(abort.signal.aborted).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});
