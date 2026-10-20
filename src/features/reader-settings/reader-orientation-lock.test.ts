import { expect, it, vi } from 'vitest';
import { ReaderOrientationLock, type ReaderOrientation } from './reader-orientation-lock';

it('persists direction and auto across reloads while releasing only the live lock on reader exit', async () => {
  let saved: ReaderOrientation;
  const preference = {
    read: () => saved,
    write: (value: ReaderOrientation) => {
      saved = value;
    },
  };
  const lock = vi.fn(async () => {});
  const unlock = vi.fn();
  const first = new ReaderOrientationLock(lock, unlock, preference);
  first.setActive(true);
  await first.setOrientation('landscape');
  expect(lock).toHaveBeenLastCalledWith('landscape');
  const stopListening = first.subscribe(() => {});
  stopListening();
  expect(unlock).not.toHaveBeenCalled();
  first.setActive(false);
  await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
  expect(saved).toBe('landscape');
  const restored = new ReaderOrientationLock(lock, unlock, preference);
  expect(restored.snapshot()).toBe('landscape');
  restored.setActive(true);
  await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
  await restored.setOrientation(undefined);
  expect(saved).toBeUndefined();
  expect(new ReaderOrientationLock(lock, unlock, preference).snapshot()).toBeUndefined();
});

it('releases a late native request when the reader exits without erasing its saved preference', async () => {
  let resolve!: () => void;
  const lock = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const unlock = vi.fn();
  const owner = new ReaderOrientationLock(lock, unlock, { read: () => 'portrait', write: vi.fn() });
  owner.setActive(true);
  await Promise.resolve();
  expect(lock).toHaveBeenCalledWith('portrait');
  owner.setActive(false);
  resolve();
  await vi.waitFor(() => expect(unlock).toHaveBeenCalledOnce());
  expect(owner.snapshot()).toBe('portrait');
});

it('retains preference when the browser rejects locking and retries on foreground/fullscreen', async () => {
  const lock = vi.fn().mockRejectedValueOnce(Error('fullscreen required')).mockResolvedValue(undefined);
  const owner = new ReaderOrientationLock(lock, vi.fn(), { read: () => 'portrait', write: vi.fn() });
  owner.setActive(true);
  await vi.waitFor(() => expect(lock).toHaveBeenCalledOnce());
  expect(owner.snapshot()).toBe('portrait');
  owner.reapply();
  await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2));
});
