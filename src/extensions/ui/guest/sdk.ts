import type {
  UiPluginDefinition,
  UiPluginContext,
  UiDisposable,
  UiInvocation,
} from '../../../../packages/extension-contracts/ui-sdk';
import type { UiContext } from '../../../../packages/extension-contracts/ui-lifecycle';
import {
  validateUiCommandInvocation,
  validateUiCancel,
  validateUiContextEvent,
} from '@boaa/extension-contracts/ui-protocol';
import { GuestRpcClient } from './client';
export class GuestSdk {
  private definition?: UiPluginDefinition;
  private cleanup: UiDisposable[] = [];
  private handlers = new Map<string, (invocation: UiInvocation) => void | Promise<void>>();
  private running = new Map<string, AbortController>();
  private listeners = new Set<(context: Readonly<UiContext>) => void>();
  private context: Readonly<UiContext>;
  private contextSequence = 0;
  private invocationSequence = 0;
  private nextHandler = 0;
  private phase: 'loading' | 'activating' | 'ready' | 'stopped' = 'loading';
  private readonly rpc: GuestRpcClient;
  private stopping?: Promise<void>;
  readonly register = (definition: UiPluginDefinition): void => {
    if (
      this.definition ||
      this.phase !== 'loading' ||
      definition?.apiVersion !== 1 ||
      typeof definition.activate !== 'function' ||
      (definition.deactivate !== undefined && typeof definition.deactivate !== 'function')
    ) {
      this.fatal();
      throw new Error('INVALID_ARGUMENT');
    }
    this.definition = definition;
  };
  constructor(
    private readonly sessionId: string,
    initial: UiContext,
    private readonly send: (value: unknown) => void,
    private readonly fatal: () => void,
  ) {
    this.context = Object.freeze({ ...initial });
    this.rpc = new GuestRpcClient(sessionId, send, fatal);
  }
  private add(dispose: UiDisposable): UiDisposable {
    if (this.phase === 'stopped' || this.cleanup.length >= 128 || typeof dispose !== 'function')
      throw new Error('QUOTA_EXCEEDED');
    let active = true;
    const once = async () => {
      if (!active) return;
      active = false;
      this.cleanup = this.cleanup.filter((d) => d !== once);
      await dispose();
    };
    this.cleanup.push(once);
    return once;
  }
  async activate(): Promise<void> {
    if (this.phase !== 'loading' || !this.definition) {
      this.fatal();
      return;
    }
    this.phase = 'activating';
    const getContext = () => this.context;
    const ctx: UiPluginContext = Object.freeze({
      runtime: Object.freeze({ getCapabilities: () => this.rpc.call('runtime.getCapabilities', {}) }),
      storage: Object.freeze({
        get: (p: Parameters<UiPluginContext['storage']['get']>[0]) => this.rpc.call('storage.get', p),
        set: (p: Parameters<UiPluginContext['storage']['set']>[0]) => this.rpc.call('storage.set', p),
        remove: (p: Parameters<UiPluginContext['storage']['remove']>[0]) => this.rpc.call('storage.remove', p),
        list: (p: Parameters<UiPluginContext['storage']['list']>[0]) => this.rpc.call('storage.list', p),
      }),
      reader: Object.freeze({
        consumeSelection: (token: string) => this.rpc.call('reader.consumeSelection', { token }),
      }),
      commands: Object.freeze({
        register: async (commandId: string, handler: (invocation: UiInvocation) => void | Promise<void>) => {
          if (typeof handler !== 'function' || this.handlers.size >= 10 || this.phase === 'stopped')
            throw new Error('INVALID_ARGUMENT');
          const handlerId = `h${++this.nextHandler}`;
          this.handlers.set(handlerId, handler);
          try {
            const { registrationId } = await this.rpc.call('commands.register', { commandId, handlerId });
            return this.add(async () => {
              this.handlers.delete(handlerId);
              if (this.phase !== 'stopped') await this.rpc.call('commands.unregister', { registrationId });
            });
          } catch (e) {
            this.handlers.delete(handlerId);
            throw e;
          }
        },
      }),
      ui: Object.freeze({
        get context() {
          return getContext();
        },
        onContextChanged: (handler: (context: Readonly<UiContext>) => void) => {
          if (typeof handler !== 'function' || this.listeners.size >= 32) throw new Error('INVALID_ARGUMENT');
          this.listeners.add(handler);
          return this.add(() => {
            this.listeners.delete(handler);
          });
        },
      }),
      subscriptions: Object.freeze({ add: (dispose: UiDisposable) => this.add(dispose) }),
    });
    try {
      await this.definition.activate(ctx);
      if ((this.phase as string) === 'stopped') return;
      this.phase = 'ready';
      this.send({ wireVersion: 1, kind: 'lifecycle', sessionId: this.sessionId, state: 'ready' });
    } catch {
      this.fatal();
    }
  }
  receive(value: unknown): void {
    if (this.phase === 'stopped') return;
    if (validateUiCancel(value) && value.sessionId === this.sessionId) {
      this.running.get(value.requestId)?.abort();
      return;
    }
    if (validateUiContextEvent(value) && value.sessionId === this.sessionId) {
      if (value.sequence <= this.contextSequence || value.payload.panelId !== this.context.panelId) {
        this.fatal();
        return;
      }
      this.contextSequence = value.sequence;
      this.context = Object.freeze({ ...value.payload });
      try {
        for (const listener of this.listeners) listener(this.context);
      } catch {
        this.fatal();
      }
      return;
    }
    if (validateUiCommandInvocation(value) && value.sessionId === this.sessionId) {
      if (
        this.phase !== 'ready' ||
        this.running.size >= 4 ||
        !/^i[1-9][0-9]{0,14}$/.test(value.requestId) ||
        Number(value.requestId.slice(1)) <= this.invocationSequence
      ) {
        this.fatal();
        return;
      }
      this.invocationSequence = Number(value.requestId.slice(1));
      const handler = this.handlers.get(value.handlerId);
      if (!handler) {
        this.fatal();
        return;
      }
      const controller = new AbortController();
      this.running.set(value.requestId, controller);
      const finish = (ok: boolean) => {
        this.running.delete(value.requestId);
        if (!controller.signal.aborted && this.phase !== 'stopped')
          this.send({
            wireVersion: 1,
            kind: 'invocationResult',
            sessionId: this.sessionId,
            requestId: value.requestId,
            ok,
          });
      };
      void Promise.resolve()
        .then(() =>
          handler(
            Object.freeze({
              invocationId: value.invocationId,
              ...(value.selectionToken ? { selectionToken: value.selectionToken } : {}),
              signal: controller.signal,
            }),
          ),
        )
        .then(
          () => finish(true),
          () => finish(false),
        );
      return;
    }
    this.rpc.receive(value);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.phase = 'stopped';
    this.rpc.close();
    for (const running of this.running.values()) running.abort();
    this.running.clear();
    this.handlers.clear();
    this.listeners.clear();
    const cleanup = this.cleanup.splice(0).reverse();
    this.stopping = (async () => {
      try {
        await this.definition?.deactivate?.();
      } catch {
        /* Cleanup must continue. */
      }
      for (const dispose of cleanup)
        try {
          await dispose();
        } catch {
          /* Best effort within the host deadline. */
        }
      this.send({ wireVersion: 1, kind: 'lifecycle', sessionId: this.sessionId, state: 'stopped' });
    })();
    return this.stopping;
  }
}
