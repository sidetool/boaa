import { describe, expect, it, vi } from 'vitest';
import { AssetWriteBatch } from './asset-write-batch.js';

function setup(maxBytes = 16) {
  const batches: number[][] = [];
  const write = vi.fn(async (_asset: number) => undefined);
  const beforeWrite = vi.fn(async (assets: readonly number[]) => {
    batches.push([...assets]);
  });
  const afterWrite = vi.fn(async () => undefined);
  const batch = new AssetWriteBatch({
    maxCount: 4,
    maxBytes,
    byteLength: (n: number) => n,
    beforeWrite,
    write,
    afterWrite,
  });
  return { batch, batches, write, beforeWrite, afterWrite };
}

describe('bounded import asset writes', () => {
  it('flushes full batches and the final tail without starting detached writes', async () => {
    const { batch, batches, write } = setup();
    for (let i = 0; i < 3; i++) await batch.add(1);
    expect(write).not.toHaveBeenCalled();
    await batch.add(1);
    expect(write).toHaveBeenCalledTimes(4);
    await batch.add(2);
    await batch.flush();
    await batch.flush();
    expect(batches).toEqual([[1, 1, 1, 1], [2]]);
  });

  it('bounds batch bytes and writes oversized individual assets alone', async () => {
    const { batch, batches } = setup();
    for (const bytes of [9, 8, 20, 2]) await batch.add(bytes);
    await batch.flush();
    expect(batches).toEqual([[9], [8], [20], [2]]);
  });

  it.each(['sync', 'async'] as const)('drains successful siblings after a %s write failure', async (mode) => {
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completed: number[] = [];
    const failure = new Error('storage offline');
    const afterWrite = vi.fn(async () => undefined);
    const batch = new AssetWriteBatch({
      maxCount: 2,
      maxBytes: 16,
      byteLength: () => 1,
      beforeWrite: async () => undefined,
      write: (n: number) => {
        if (n === 1) {
          if (mode === 'sync') throw failure;
          return Promise.reject(failure);
        }
        return delayed.then(() => {
          completed.push(n);
        });
      },
      afterWrite,
    });
    await batch.add(1);
    let settled = false;
    const result = batch.add(2).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await result).toBe(failure);
    expect(completed).toEqual([2]);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('starts no writes when cancellation or reservation rejects', async () => {
    const { batch, beforeWrite, write } = setup();
    beforeWrite.mockRejectedValueOnce(new Error('cancelled'));
    await batch.add(1);
    await expect(batch.flush()).rejects.toThrow('cancelled');
    expect(write).not.toHaveBeenCalled();
  });
});
