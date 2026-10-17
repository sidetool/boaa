import { expect, it, vi } from 'vitest';
import { SettingsSubscriptions } from './guest/settings-subscriptions';
const snapshot = (revision: number) => ({ schemaVersion: 1, revision, value: { color: '#112233' } });
it('keeps a newer event when the initial request reply arrives late', async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void;
  const pending = new Promise<ReturnType<typeof snapshot>>((r) => {
    release = r;
  });
  const listener = vi.fn();
  const observer = new SettingsSubscriptions(async () => pending, vi.fn());
  const ready = observer.subscribe(listener);
  observer.receive(1, snapshot(3));
  release(snapshot(1));
  await ready;
  observer.receive(1, snapshot(2));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(snapshot(3));
  observer.close();
});
it('coalesces changes during an async callback and drops queued updates on disposal', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const listener = vi.fn().mockImplementationOnce(() => hold);
  const request = vi.fn(async () => snapshot(1));
  const observer = new SettingsSubscriptions(request, vi.fn());
  const lease = await observer.subscribe(listener);
  observer.receive(1, snapshot(2));
  observer.receive(1, snapshot(3));
  expect(listener).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
  expect(listener.mock.calls[1][0]).toEqual(snapshot(3));
  await lease.dispose();
  await lease.dispose();
  observer.receive(1, snapshot(4));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(2);
  observer.close();
});
it('bounds subscriptions and does not close a view for a denied permission', async () => {
  const fail = vi.fn();
  const request = vi.fn().mockRejectedValueOnce(Error('REQUEST_DENIED')).mockResolvedValue(null);
  const observer = new SettingsSubscriptions(request, fail);
  await expect(observer.subscribe(vi.fn())).rejects.toThrow('REQUEST_DENIED');
  expect(fail).not.toHaveBeenCalled();
  for (let i = 0; i < 8; i++) await observer.subscribe(vi.fn());
  await expect(observer.subscribe(vi.fn())).rejects.toThrow('SUBSCRIPTION_LIMIT');
  expect(request).toHaveBeenCalledTimes(9);
  observer.close();
});
it('closes an ambiguous timed-out watch and rejects malformed snapshots', async () => {
  const fail = vi.fn();
  const observer = new SettingsSubscriptions(async () => {
    throw Error('TIMEOUT');
  }, fail);
  await expect(observer.subscribe(vi.fn())).rejects.toThrow('TIMEOUT');
  expect(fail).toHaveBeenCalledOnce();
  observer.close();
  const bad = new SettingsSubscriptions(async () => ({ revision: 1 }), fail);
  await expect(bad.subscribe(vi.fn())).rejects.toThrow('INVALID_CONFIG');
  expect(fail).toHaveBeenCalledTimes(2);
  bad.close();
});
it('does not deliver a prepared snapshot after close, including late replies', async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void;
  const listener = vi.fn(),
    fail = vi.fn();
  const observer = new SettingsSubscriptions(
    () =>
      new Promise((r) => {
        release = r;
      }),
    fail,
  );
  const ready = observer.subscribe(listener);
  observer.close();
  release(snapshot(1));
  await expect(ready).rejects.toThrow('VIEW_CLOSED');
  observer.receive(1, snapshot(2));
  expect(listener).not.toHaveBeenCalled();
});
it('discards the coalesced snapshot when disposed during a slow callback', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const listener = vi.fn(() => hold);
  const observer = new SettingsSubscriptions(async () => snapshot(1), vi.fn());
  const lease = await observer.subscribe(listener);
  observer.receive(1, snapshot(2));
  await lease.dispose();
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledOnce();
  observer.close();
});
it('contains rejected callbacks instead of leaving an unhandled promise or replay queue', async () => {
  const fail = vi.fn();
  const observer = new SettingsSubscriptions(async () => snapshot(1), fail);
  await observer.subscribe(async () => {
    throw Error('guest');
  });
  await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
  observer.receive(1, snapshot(2));
  expect(fail).toHaveBeenCalledOnce();
  observer.close();
});
