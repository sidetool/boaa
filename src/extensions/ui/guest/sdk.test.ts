import { expect, it, vi } from 'vitest';
import { GuestSdk } from './sdk';
import type { UiPluginContext } from '../../../../packages/extension-contracts/ui-sdk';
const context = { theme: 'light', locale: 'ko', panelId: 'org.test.panel' } as const;
it('registers once, awaits activation RPC, and disposes in reverse order despite cleanup errors', async () => {
  const messages: unknown[] = [],
    disposed: string[] = [];
  const sdk = new GuestSdk('s', context, (message) => messages.push(message), vi.fn());
  let ctx!: UiPluginContext;
  sdk.register({
    apiVersion: 1,
    async activate(value) {
      ctx = value;
      value.subscriptions.add(() => {
        disposed.push('first');
      });
      value.subscriptions.add(() => {
        disposed.push('last');
        throw Error('cleanup');
      });
      await value.storage.get({ key: 'k' });
    },
    deactivate() {
      disposed.push('deactivate');
    },
  });
  const active = sdk.activate();
  expect(messages).toHaveLength(1);
  sdk.receive({
    wireVersion: 1,
    kind: 'response',
    sessionId: 's',
    requestId: 'r1',
    ok: true,
    result: { found: false },
  });
  await active;
  expect(messages[1]).toMatchObject({ kind: 'lifecycle', state: 'ready' });
  await sdk.stop();
  await sdk.stop();
  expect(disposed).toEqual(['deactivate', 'last', 'first']);
  await expect(ctx.storage.get({ key: 'k' })).rejects.toThrow('PLUGIN_STOPPED');
});
it('rejects duplicate definitions and responses from another session', async () => {
  const fatal = vi.fn();
  const sdk = new GuestSdk('s', context, () => {}, fatal);
  const definition = { apiVersion: 1, activate() {} } as const;
  sdk.register(definition);
  expect(() => sdk.register(definition)).toThrow('INVALID_ARGUMENT');
  expect(fatal).toHaveBeenCalledOnce();
  await sdk.stop();
  const otherFatal = vi.fn();
  const other = new GuestSdk('s', context, () => {}, otherFatal);
  other.register({
    apiVersion: 1,
    async activate(ctx) {
      await ctx.storage.get({ key: 'k' });
    },
  });
  const pending = other.activate();
  other.receive({
    wireVersion: 1,
    kind: 'response',
    sessionId: 'wrong',
    requestId: 'r1',
    ok: true,
    result: { found: false },
  });
  expect(otherFatal).toHaveBeenCalledOnce();
  await other.stop();
  await pending;
});
it('applies ordered immutable context snapshots and rejects stale or different-panel events', async () => {
  const fatal = vi.fn();
  let ctx!: UiPluginContext;
  const events: string[] = [];
  const sdk = new GuestSdk('s', context, () => {}, fatal);
  sdk.register({
    apiVersion: 1,
    activate(c) {
      ctx = c;
      c.ui.onContextChanged((v) => events.push(v.theme));
    },
  });
  await sdk.activate();
  const event = {
    wireVersion: 1,
    kind: 'event',
    sessionId: 's',
    eventId: 'e',
    sequence: 1,
    event: 'ui.contextChanged',
    payload: { ...context, theme: 'dark' },
  };
  sdk.receive(event);
  expect(ctx.ui.context.theme).toBe('dark');
  expect(Object.isFrozen(ctx.ui.context)).toBe(true);
  sdk.receive(event);
  expect(fatal).toHaveBeenCalledOnce();
  expect(events).toEqual(['dark']);
  sdk.receive({ ...event, sequence: 2, payload: { ...context, panelId: 'org.other.panel' } });
  expect(fatal).toHaveBeenCalledTimes(2);
  await sdk.stop();
});
it('aborts command callbacks at stop and never posts their late results', async () => {
  const messages: unknown[] = [];
  let signal!: AbortSignal, finish!: () => void;
  const sdk = new GuestSdk('s', context, (m) => messages.push(m), vi.fn());
  sdk.register({
    apiVersion: 1,
    async activate(ctx) {
      await ctx.commands.register('org.test.command', async (invocation) => {
        signal = invocation.signal;
        await new Promise<void>((r) => {
          finish = r;
        });
      });
    },
  });
  const ready = sdk.activate();
  sdk.receive({
    wireVersion: 1,
    kind: 'response',
    sessionId: 's',
    requestId: 'r1',
    ok: true,
    result: { registrationId: 'reg' },
  });
  await ready;
  sdk.receive({
    wireVersion: 1,
    kind: 'invoke',
    sessionId: 's',
    requestId: 'i1',
    invocationId: 'inv',
    handlerId: 'h1',
  });
  await Promise.resolve();
  await sdk.stop();
  expect(signal.aborted).toBe(true);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'invocationResult' })]));
});
