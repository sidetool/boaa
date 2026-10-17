import type { UI_ERROR_CODES } from '@boaa/extension-contracts/ui-protocol';
import type { BrowserUiManifest, UiPermission, UiFeature } from '@boaa/extension-contracts/ui-package';
import {
  validateUiRequest,
  validateUiCancel,
  validateUiCommandResult,
  validateUiResponse,
  type UiRequest,
  type UiMethod,
} from '@boaa/extension-contracts/ui-protocol';
import { UiPluginStore, type UiPluginSession } from './plugin-store';
import { RuntimeCommands, type ReaderContext } from './runtime-commands';
import { RUNTIME_LIMITS, requireRuntime, errorCode } from './runtime-policy';
interface Pending {
  request: UiRequest;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
}
export function methodPermission(method: UiMethod): UiPermission {
  if (method.startsWith('storage.')) return 'storage.own';
  if (method.startsWith('commands.')) return 'commands.register';
  if (method === 'reader.consumeSelection') return 'reader.selection.consume';
  return 'ui.panel.render';
}
/** Port owner supplies session; no request field can select a package/account. */
export class RuntimeDispatcher {
  readonly commands: RuntimeCommands;
  private pending = new Map<string, Pending>();
  private queue: Pending[] = [];
  private active = 0;
  private highWater = 0;
  private tokens: number = RUNTIME_LIMITS.burst;
  private refill = Date.now();
  private closed = false;
  constructor(
    private readonly store: UiPluginStore,
    private readonly session: UiPluginSession,
    private readonly sessionId: string,
    manifest: BrowserUiManifest,
    private readonly phase: () => string,
    private readonly send: (value: unknown) => void,
    private readonly fatal: (code: (typeof UI_ERROR_CODES)[number]) => void,
    reader: () => ReaderContext | null,
  ) {
    this.commands = new RuntimeCommands(
      manifest,
      sessionId,
      (p) => this.authorize(p),
      () => !this.closed && phase() === 'ready',
      reader,
      send,
    );
  }
  private async authorize(permission: UiPermission): Promise<void> {
    requireRuntime(!this.closed && ['activating', 'ready'].includes(this.phase()), 'PLUGIN_STOPPED');
    await this.store.assertSession(this.session, permission);
    requireRuntime(!this.closed, 'PLUGIN_STOPPED');
  }
  acceptControl(): boolean {
    if (this.closed) return false;
    const now = Date.now();
    this.tokens = Math.min(
      RUNTIME_LIMITS.burst,
      this.tokens + (Math.max(0, now - this.refill) * RUNTIME_LIMITS.rate) / 1000,
    );
    this.refill = now;
    if (this.tokens < 1) {
      this.fatal('QUOTA_EXCEEDED');
      return false;
    }
    this.tokens--;
    return true;
  }
  receive(value: unknown): void {
    if (!this.acceptControl()) return;
    try {
      if (validateUiCancel(value) && value.sessionId === this.sessionId) {
        const pending = this.pending.get(value.requestId);
        if (pending) {
          pending.cancelled = true;
          const queued = this.queue.indexOf(pending);
          if (queued >= 0) {
            this.queue.splice(queued, 1);
            clearTimeout(pending.timer);
            this.pending.delete(value.requestId);
          }
          // Running operations keep their deadline until settled; a cancel cannot leave a hung slot forever.
        }
        return;
      }
      if (validateUiCommandResult(value) && value.sessionId === this.sessionId) {
        void this.commands.complete(value);
        return;
      }
      requireRuntime(validateUiRequest(value) && value.sessionId === this.sessionId, 'INVALID_ARGUMENT');
      // Ordered port traffic + monotonic SDK IDs avoids an unbounded replay-ID set.
      requireRuntime(/^r[1-9][0-9]{0,14}$/.test(value.requestId), 'INVALID_ARGUMENT');
      const sequence = Number(value.requestId.slice(1));
      requireRuntime(sequence > this.highWater, 'INVALID_ARGUMENT');
      this.highWater = sequence;
      requireRuntime(this.pending.size < RUNTIME_LIMITS.concurrent + RUNTIME_LIMITS.queued, 'QUOTA_EXCEEDED');
      const pending: Pending = {
        request: value,
        cancelled: false,
        timer: setTimeout(
          () => this.fatal('TIMEOUT'),
          value.method === 'storage.set' || value.method === 'storage.remove'
            ? RUNTIME_LIMITS.writeMs
            : RUNTIME_LIMITS.readMs,
        ),
      };
      this.pending.set(value.requestId, pending);
      this.queue.push(pending);
      this.drain();
    } catch (error) {
      this.fatal(errorCode(error));
    }
  }
  private drain(): void {
    while (!this.closed && this.active < RUNTIME_LIMITS.concurrent && this.queue.length) {
      const pending = this.queue.shift()!;
      this.active++;
      void this.run(pending).finally(() => {
        clearTimeout(pending.timer);
        this.pending.delete(pending.request.requestId);
        this.active--;
        this.drain();
      });
    }
  }
  private async execute(request: UiRequest): Promise<unknown> {
    switch (request.method) {
      case 'runtime.getCapabilities': {
        const features: UiFeature[] = ['ui.readerAddonTabs'];
        for (const permission of ['commands.register', 'reader.selection.consume', 'storage.own'] as const) {
          try {
            await this.authorize(permission);
            features.push(permission);
          } catch (e) {
            if (errorCode(e) !== 'PERMISSION_DENIED') throw e;
          }
        }
        return { apiVersion: 1, apiMinor: 0, features };
      }
      case 'commands.register':
        return this.commands.register(request.params.commandId, request.params.handlerId);
      case 'commands.unregister':
        return this.commands.unregister(request.params.registrationId);
      case 'reader.consumeSelection':
        return this.commands.consume(request.params.token);
      case 'storage.get':
        return this.store.storage(this.session, request.method, request.params);
      case 'storage.set':
        return this.store.storage(this.session, request.method, request.params);
      case 'storage.remove':
        return this.store.storage(this.session, request.method, request.params);
      case 'storage.list':
        return this.store.storage(this.session, request.method, request.params);
    }
  }
  private async run(pending: Pending): Promise<void> {
    const request = pending.request;
    let result: unknown;
    const envelope = { wireVersion: 1, kind: 'response', sessionId: this.sessionId, requestId: request.requestId };
    try {
      if (pending.cancelled) return;
      await this.authorize(methodPermission(request.method));
      if (pending.cancelled) return;
      result = await this.execute(request);
      await this.authorize(methodPermission(request.method));
      if (request.method === 'reader.consumeSelection') this.commands.assertSelectionCurrent(request.params.token);
      if (pending.cancelled || this.closed) return;
      const response = { ...envelope, ok: true, result };
      requireRuntime(validateUiResponse(response, request.method), 'INTERNAL_ERROR');
      this.send(response);
    } catch (error) {
      if (pending.cancelled || this.closed) return;
      const code = errorCode(error);
      if (['PACKAGE_GENERATION_CHANGED', 'PLUGIN_STOPPED'].includes(code)) {
        this.fatal(code);
        return;
      }
      this.send({ ...envelope, ok: false, error: { code, retryable: false } });
    } finally {
      if ((pending.cancelled || this.closed) && request.method === 'commands.register' && result) {
        this.commands.unregister((result as { registrationId: string }).registrationId);
      }
    }
  }
  close(): void {
    this.closed = true;
    this.commands.close();
    this.queue = [];
    for (const pending of this.pending.values()) {
      pending.cancelled = true;
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }
}
