import {
  validateUiRequest,
  validateUiResponse,
  type UiMethod,
  type UiMethodMap,
} from '@boaa/extension-contracts/ui-protocol';
interface Pending {
  method: UiMethod;
  resolve: (value: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class GuestRpcClient {
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  constructor(
    private readonly sessionId: string,
    private readonly send: (v: unknown) => void,
    private readonly fatal: () => void,
  ) {}
  call<M extends UiMethod>(method: M, params: UiMethodMap[M]['params']): Promise<UiMethodMap[M]['result']> {
    if (this.closed) return Promise.reject(new Error('PLUGIN_STOPPED'));
    if (this.pending.size >= 20) return Promise.reject(new Error('QUOTA_EXCEEDED'));
    const requestId = `r${++this.sequence}`;
    const message = { wireVersion: 1, kind: 'request', sessionId: this.sessionId, requestId, method, params };
    if (!validateUiRequest(message)) return Promise.reject(new Error('INVALID_ARGUMENT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          this.send({ wireVersion: 1, kind: 'cancel', sessionId: this.sessionId, requestId });
          reject(new Error('TIMEOUT'));
        },
        method === 'storage.set' || method === 'storage.remove' ? 5500 : 3500,
      );
      this.pending.set(requestId, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(message);
    });
  }
  receive(value: unknown): void {
    if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string') {
      this.fatal();
      return;
    }
    const pending = this.pending.get(value.requestId);
    if (!pending) return; // Timed-out calls may complete; mutation outcome needs an idempotent retry.
    if (!validateUiResponse(value, pending.method) || value.sessionId !== this.sessionId) {
      this.fatal();
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.requestId);
    if (value.ok) pending.resolve(value.result);
    else
      pending.reject(
        Object.assign(new Error(value.error.code), { code: value.error.code, retryable: value.error.retryable }),
      );
  }
  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('PLUGIN_STOPPED'));
    }
    this.pending.clear();
  }
}
