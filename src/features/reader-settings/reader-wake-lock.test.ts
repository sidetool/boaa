import { describe, expect, it, vi } from 'vitest';
import { ReaderWakeLock, type ReaderWakeLockSentinel } from './reader-wake-lock';
function sentinel() {
  const events = new EventTarget();
  const lock = {
    released: false,
    addEventListener: events.addEventListener.bind(events),
    release: vi.fn(async () => {
      lock.released = true;
      events.dispatchEvent(new Event('release'));
    }),
  };
  return lock;
}
describe('reader-owned wake lock', () => {
  it('restores device intent after reload and saves disabling without clearing it on exit', async () => {
    let saved = false;
    const preference = {
      read: () => saved,
      write: (value: boolean) => {
        saved = value;
      },
    };
    const first = new ReaderWakeLock(
      async () => sentinel(),
      () => true,
      preference,
    );
    await first.toggle();
    first.dispose();
    expect(saved).toBe(true);
    const request = vi.fn(async () => sentinel());
    const restored = new ReaderWakeLock(request, () => true, preference);
    expect(restored.snapshot()).toBe(true);
    expect(request).not.toHaveBeenCalled();
    restored.setActive(true);
    expect(request).toHaveBeenCalledOnce();
    await restored.toggle();
    expect(saved).toBe(false);
    expect(new ReaderWakeLock(request, () => true, preference).snapshot()).toBe(false);
  });

  it('keeps working when device storage is blocked', async () => {
    const request = vi.fn(async () => sentinel());
    const owner = new ReaderWakeLock(request, () => true, {
      read: () => {
        throw Error('blocked');
      },
      write: () => {
        throw Error('blocked');
      },
    });
    owner.setActive(true);
    await owner.toggle();
    expect(request).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toBe(true);
    owner.dispose();
  });

  it('survives settings unsubscription and reacquires after background revocation', async () => {
    let visible = true;
    const locks: ReturnType<typeof sentinel>[] = [];
    const request = vi.fn(async () => {
      const lock = sentinel();
      locks.push(lock);
      return lock;
    });
    const owner = new ReaderWakeLock(request, () => visible);
    owner.setActive(true);
    const unsubscribe = owner.subscribe(() => undefined);
    await owner.toggle();
    unsubscribe();
    expect(locks[0].released).toBe(false);
    visible = false;
    owner.visibilityChanged();
    expect(locks[0].released).toBe(true);
    expect(owner.snapshot()).toBe(true);
    visible = true;
    owner.visibilityChanged();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    owner.dispose();
    expect(locks[1].released).toBe(true);
  });
  it('releases late requests after disable and never acquires outside the reader', async () => {
    let resolve!: (lock: ReaderWakeLockSentinel) => void;
    const request = vi.fn(
      () =>
        new Promise<ReaderWakeLockSentinel>((r) => {
          resolve = r;
        }),
    );
    const owner = new ReaderWakeLock(request, () => true);
    await owner.toggle();
    expect(request).not.toHaveBeenCalled();
    owner.setActive(true);
    await owner.toggle();
    const lock = sentinel();
    resolve(lock);
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.released).toBe(true);
    expect(owner.snapshot()).toBe(false);
  });
  it('does not loop on OS release or rejection, but retries on foreground', async () => {
    const lock = sentinel();
    const request = vi.fn().mockRejectedValueOnce(new Error('battery')).mockResolvedValue(lock);
    const owner = new ReaderWakeLock(request, () => true);
    owner.setActive(true);
    await owner.toggle();
    expect(owner.snapshot()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    owner.visibilityChanged();
    await Promise.resolve();
    await Promise.resolve();
    await lock.release();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
