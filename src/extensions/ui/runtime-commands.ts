import type { BrowserUiManifest, UiPermission } from '@boaa/extension-contracts/ui-package';
import { validateUiResponse, type SharedSelection, type UiCommandResult } from '@boaa/extension-contracts/ui-protocol';
import { RUNTIME_LIMITS, UiRuntimeError, requireRuntime } from './runtime-policy';
export interface ReaderContext {
  key: string;
  bookId: string;
  documentRevision: string;
}
export interface SelectionCapture {
  contextKey: string;
  selection: SharedSelection;
}
interface Invocation {
  token?: string;
  capture?: SelectionCapture;
  expires: number;
  consumed: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** Only trusted host menu actions may invoke. Reader capture/gesture UI is connected in P4. */
export class RuntimeCommands {
  private registrations = new Map<string, { commandId: string; handlerId: string }>();
  private invocations = new Map<string, Invocation>();
  private counter = 0;
  constructor(
    private readonly manifest: BrowserUiManifest,
    private readonly sessionId: string,
    private readonly authorize: (permission: UiPermission) => Promise<void>,
    private readonly ready: () => boolean,
    private readonly reader: () => ReaderContext | null,
    private readonly send: (message: unknown) => void,
  ) {}
  register(commandId: string, handlerId: string): { registrationId: string } {
    requireRuntime(
      this.manifest.extension.contributes.commands?.some((c) => c.id === commandId),
      'PERMISSION_DENIED',
    );
    requireRuntime(
      ![...this.registrations.values()].some((c) => c.commandId === commandId || c.handlerId === handlerId),
      'INVALID_ARGUMENT',
    );
    const registrationId = crypto.randomUUID();
    this.registrations.set(registrationId, { commandId, handlerId });
    return { registrationId };
  }
  unregister(id: string): null {
    this.registrations.delete(id);
    return null;
  }
  private current(capture: SelectionCapture): boolean {
    const current = this.reader();
    const capturedAt = Date.parse(capture.selection.capturedAt);
    const now = Date.now();
    return (
      Number.isFinite(capturedAt) &&
      capturedAt <= now &&
      now - capturedAt < RUNTIME_LIMITS.selectionMs &&
      !!current &&
      current.key === capture.contextKey &&
      current.bookId === capture.selection.location.bookId &&
      current.documentRevision === capture.selection.location.documentRevision
    );
  }
  async invoke(commandId: string, captured?: SelectionCapture): Promise<void> {
    // Copy before awaiting: a later host selection cannot replace the clicked snapshot.
    const capture = captured && structuredClone(captured);
    await this.authorize('commands.register');
    if (capture) await this.authorize('reader.selection.consume');
    requireRuntime(this.ready(), 'PLUGIN_STOPPED');
    const command = [...this.registrations.values()].find((c) => c.commandId === commandId);
    requireRuntime(command, 'CAPABILITY_UNAVAILABLE');
    requireRuntime(this.invocations.size < RUNTIME_LIMITS.concurrent, 'QUOTA_EXCEEDED');
    if (capture) {
      requireRuntime(
        validateUiResponse(
          {
            wireVersion: 1,
            kind: 'response',
            sessionId: this.sessionId,
            requestId: 'validation',
            ok: true,
            result: capture.selection,
          },
          'reader.consumeSelection',
        ),
        'INVALID_ARGUMENT',
      );
      requireRuntime(this.current(capture), 'CONTEXT_STALE');
    }
    const requestId = `i${++this.counter}`;
    const token = capture ? crypto.randomUUID() : undefined;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.invocations.delete(requestId);
        this.send({ wireVersion: 1, kind: 'cancel', sessionId: this.sessionId, requestId });
        reject(new UiRuntimeError('TIMEOUT'));
      }, RUNTIME_LIMITS.invocationMs);
      this.invocations.set(requestId, {
        token,
        capture,
        expires: Date.now() + RUNTIME_LIMITS.selectionMs,
        consumed: false,
        resolve,
        reject,
        timer,
      });
      this.send({
        wireVersion: 1,
        kind: 'invoke',
        sessionId: this.sessionId,
        requestId,
        invocationId: crypto.randomUUID(),
        handlerId: command.handlerId,
        ...(token ? { selectionToken: token } : {}),
      });
    });
  }
  consume(token: string): SharedSelection {
    requireRuntime(this.ready(), 'CONTEXT_STALE');
    const invocation = [...this.invocations.values()].find((i) => i.token === token);
    requireRuntime(
      invocation && !invocation.consumed && invocation.capture && invocation.expires > Date.now(),
      'CONTEXT_STALE',
    );
    invocation.consumed = true;
    requireRuntime(this.current(invocation.capture), 'CONTEXT_STALE');
    return structuredClone(invocation.capture.selection);
  }
  assertSelectionCurrent(token: string): void {
    const i = [...this.invocations.values()].find((i) => i.token === token);
    requireRuntime(i?.capture && i.expires > Date.now() && this.current(i.capture), 'CONTEXT_STALE');
  }
  async complete(result: UiCommandResult): Promise<void> {
    const invocation = this.invocations.get(result.requestId);
    if (!invocation) return; // A timed-out/cancelled handler may finish late.
    try {
      await this.authorize('commands.register');
      requireRuntime(this.ready(), 'PLUGIN_STOPPED');
      if (invocation.capture) requireRuntime(this.current(invocation.capture), 'CONTEXT_STALE');
    } catch (error) {
      if (this.invocations.get(result.requestId) === invocation) {
        this.invocations.delete(result.requestId);
        clearTimeout(invocation.timer);
        invocation.reject(error instanceof Error ? error : new UiRuntimeError('INTERNAL_ERROR'));
      }
      return;
    }
    if (this.invocations.get(result.requestId) !== invocation) return;
    this.invocations.delete(result.requestId);
    clearTimeout(invocation.timer);
    if (result.ok) invocation.resolve();
    else invocation.reject(new UiRuntimeError('INTERNAL_ERROR'));
  }
  contextChanged(): void {
    for (const [id, i] of this.invocations)
      if (i.capture && !this.current(i.capture)) {
        this.invocations.delete(id);
        clearTimeout(i.timer);
        this.send({ wireVersion: 1, kind: 'cancel', sessionId: this.sessionId, requestId: id });
        i.reject(new UiRuntimeError('CONTEXT_STALE'));
      }
  }
  close(): void {
    this.registrations.clear();
    for (const i of this.invocations.values()) {
      clearTimeout(i.timer);
      i.reject(new UiRuntimeError('PLUGIN_STOPPED'));
    }
    this.invocations.clear();
  }
}
