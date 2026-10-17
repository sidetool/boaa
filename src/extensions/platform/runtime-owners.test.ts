import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeOwners } from './runtime-owners';
const owners: RuntimeOwners[] = [];
const create = () => {
  const owner = new RuntimeOwners();
  owners.push(owner);
  return owner;
};
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('accepts a live UI owner without confusing its marker with a crashed controller', async () => {
  const controller = create(),
    ui = create();
  ui.add('opaque-ui-instance');
  await expect(controller.assertLive(['opaque-ui-instance'])).resolves.toBeUndefined();
  ui.remove('opaque-ui-instance');
  await expect(controller.assertLive(['opaque-ui-instance'])).rejects.toThrow('RECOVERY_REQUIRED');
});
it('never lets one live marker authorize an unknown marker', async () => {
  const first = create(),
    second = create();
  first.add('known');
  await expect(second.assertLive(['known', 'unknown'])).rejects.toThrow('RECOVERY_REQUIRED');
});
it('drops ownership on close', async () => {
  const owner = create();
  owner.add('closed');
  owner.close();
  await expect(owner.assertLive(['closed'])).rejects.toThrow('RECOVERY_REQUIRED');
});

function controlledChannel() {
  class Channel extends EventTarget {
    onmessage: unknown;
    postMessage = vi.fn();
    close = vi.fn();
    reply(data: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
  const channel = new Channel();
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      constructor() {
        return channel;
      }
    },
  );
  return channel;
}
it('waits for delayed exact-token responses, retries, and resolves immediately when all owners answer', async () => {
  vi.useFakeTimers();
  const channel = controlledChannel(),
    owner = create();
  const check = owner.assertLive(['a', 'b']);
  const settled = vi.fn();
  void check.then(settled);
  const token = channel.postMessage.mock.calls[0][0].token;
  channel.reply({ kind: 'alive', token: 'wrong', ids: ['a', 'b'] });
  await vi.advanceTimersByTimeAsync(700);
  expect(settled).not.toHaveBeenCalled();
  expect(channel.postMessage).toHaveBeenCalledTimes(2);
  channel.reply({ kind: 'alive', token, ids: ['a'] });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).not.toHaveBeenCalled();
  channel.reply({ kind: 'alive', token, ids: ['b'] });
  await expect(check).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it('fails closed at the deadline even with partial replies', async () => {
  vi.useFakeTimers();
  const channel = controlledChannel(),
    owner = create();
  const check = expect(owner.assertLive(['a', 'missing'])).rejects.toThrow('RECOVERY_REQUIRED');
  channel.reply({ kind: 'alive', token: channel.postMessage.mock.calls[0][0].token, ids: ['a'] });
  await vi.advanceTimersByTimeAsync(2000);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels pending checks and their timers immediately on close', async () => {
  vi.useFakeTimers();
  controlledChannel();
  const owner = create();
  const check = expect(owner.assertLive(['missing'])).rejects.toThrow('RECOVERY_REQUIRED');
  owner.close();
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
