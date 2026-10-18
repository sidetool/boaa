import { describe, expect, it, vi } from 'vitest';
import { OwnerRuntimeRegistry } from './owner-runtime-registry.js';

describe('owner runtime admission', () => {
  it('coalesces same-owner opens, isolates owners, and never evicts a live response', async () => {
    const open = vi.fn(async (owner: string) => ({ owner, close: vi.fn() }));
    const registry = new OwnerRuntimeRegistry(open, 2);
    try {
      const [a, a2, b] = await Promise.all([registry.acquire('a'), registry.acquire('a'), registry.acquire('b')]);
      expect(a.value).toBe(a2.value);
      expect(a.value).not.toBe(b.value);
      expect(open).toHaveBeenCalledTimes(2);
      await expect(registry.acquire('c')).rejects.toMatchObject({ statusCode: 429 });
      a.release();
      a2.release();
      const c = await registry.acquire('c');
      expect(a.signal.aborted).toBe(true);
      expect(a.value.close).toHaveBeenCalledOnce();
      expect(b.signal.aborted).toBe(false);
      c.release();
      b.release();
    } finally {
      await registry.close();
    }
  });
  it('retains capacity while asynchronous close is pending', async () => {
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const open = vi.fn(async (owner: string) => ({ close: () => (owner === 'a' ? closing : Promise.resolve()) }));
    const registry = new OwnerRuntimeRegistry(open, 1);
    const a = await registry.acquire('a');
    a.release();
    const b = registry.acquire('b');
    const c = registry.acquire('c');
    await Promise.resolve();
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    finish();
    const results = await Promise.allSettled([b, c]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'fulfilled') result.value.release();
    await registry.close();
  });
  it('disabling one owner aborts only its pending work and disposes its bundle', async () => {
    const registry = new OwnerRuntimeRegistry(async () => ({ close: vi.fn() }));
    const a = await registry.acquire('a'),
      b = await registry.acquire('b');
    await registry.dispose('a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(a.value.close).toHaveBeenCalledOnce();
    a.release();
    b.release();
    await registry.close();
  });
});
