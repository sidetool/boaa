import { UiStoreError } from '../ui/store-model';
import { isUiJson, uiRecord, uiKeys, type UiJson } from '@boaa/extension-contracts/ui-json';
import { canonicalJson, requireStore } from '../ui/store-model';
import type { PlatformFence } from '../../../packages/extension-contracts/plugin-platform-sdk';
export type ControllerOp = 'describe' | 'activate' | 'event' | 'command' | 'task' | 'migrate' | 'handler' | 'decorate';
const counts = { workers: 0, calls: 0 };
export const controllerResources = () => ({ ...counts });
interface Call {
  id: number;
  op: ControllerOp;
  text: string;
  resolve: (value: UiJson) => void;
  reject: (error: Error) => void;
  abort: AbortController;
  cancelled: boolean;
  detach: () => void;
}
export interface ControllerOptions {
  worker: () => Worker;
  wasmUrl: string;
  /** Host-selected watchdog; never provided by guest input. */
  invocationMs?: number;
  broker: (method: string, input: UiJson, signal: AbortSignal) => Promise<UiJson>;
  onStop: (reason: string) => void;
}
/** Owns one host Worker/QuickJS context. No synthetic permissions or test-only generic guest RPC. */
export class ControllerVm {
  private worker: Worker;
  private queue: Call[] = [];
  private current?: Call;
  private stopped = false;
  private ready = false;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout>;
  private rpcCount = 0;
  private rpcIds = new Set<number>();
  private readonly fenceKey: string;
  constructor(
    private readonly session: {
      readonly role: 'controller' | 'ui' | 'task' | 'migration';
      readonly fence: Readonly<PlatformFence>;
    },
    source: string,
    private readonly options: ControllerOptions,
  ) {
    requireStore(counts.workers < 4, 'WORKER_LIMIT');
    this.fenceKey = canonicalJson(session.fence as unknown as UiJson);
    this.worker = options.worker();
    counts.workers++;
    this.timer = setTimeout(() => this.stop('START_TIMEOUT'), 5000);
    this.worker.onerror = () => this.stop('WORKER_ERROR');
    this.worker.onmessage = ({ data }) => {
      void this.message(data).catch(() => this.stop('INVALID_MESSAGE'));
    };
    this.send({ kind: 'init', role: session.role, fence: session.fence, source, wasmUrl: options.wasmUrl });
  }
  private send(message: unknown): void {
    if (this.stopped) return;
    try {
      this.worker.postMessage(message);
    } catch {
      this.stop('WORKER_ERROR');
    }
  }

  private async message(m: unknown): Promise<void> {
    if (this.stopped) return;
    requireStore(isUiJson(m, 100 * 1024) && uiRecord(m), 'INVALID_MESSAGE');
    if (canonicalJson(m.fence as UiJson) !== this.fenceKey) {
      this.stop('CONTEXT_STALE');
      return;
    }
    if (m.kind === 'failure') {
      this.stop('GUEST_FAILURE');
      return;
    }
    if (m.kind === 'ready') {
      requireStore(!this.ready, 'INVALID_MESSAGE');
      clearTimeout(this.timer);
      this.ready = true;
      this.next();
      return;
    }
    const call = this.current;
    requireStore(call, 'INVALID_MESSAGE');
    if (m.kind === 'rpc') {
      requireStore(
        m.invocationId === call.id &&
          Number.isSafeInteger(m.id) &&
          (m.id as number) > 0 &&
          !this.rpcIds.has(m.id as number) &&
          ++this.rpcCount <= 32 &&
          typeof m.text === 'string' &&
          m.text.length <= 65536,
        'INVALID_RPC',
      );
      this.rpcIds.add(m.id as number);
      if (call.cancelled) return;
      const request: unknown = JSON.parse(m.text);
      requireStore(
        isUiJson(request, 65536) &&
          uiRecord(request) &&
          uiKeys(request, ['method', 'input']) &&
          typeof request.method === 'string',
        'INVALID_RPC',
      );
      let reply: UiJson;
      try {
        reply = {
          ok: true,
          value: await this.options.broker(request.method, request.input as UiJson, call.abort.signal),
        };
      } catch (error) {
        const annotationCodes = [
          'ANNOTATION_CONFLICT',
          'ANNOTATION_OUTCOME_UNKNOWN',
          'ANNOTATION_HANDLE_INVALID',
          'ANNOTATION_BUSY',
          'ANNOTATION_LIMIT',
          'ANNOTATION_RATE_LIMIT',
          'ANNOTATION_BACKEND_UNSUPPORTED',
          'CONTENT_CHANGED',
          'READER_CONTEXT_STALE',
        ];
        const code =
          request.method.startsWith('reader.annotations.') &&
          error instanceof UiStoreError &&
          annotationCodes.includes(error.code)
            ? error.code
            : 'HOST_REQUEST_DENIED';
        reply = { ok: false, code: call.abort.signal.aborted ? 'CANCELLED' : code };
      }
      if (this.stopped || this.current !== call || call.cancelled) return;
      requireStore(isUiJson(reply, 65536), 'OUTPUT_LIMIT');
      this.send({ kind: 'reply', fence: this.session.fence, id: m.id, text: JSON.stringify(reply) });
      return;
    }
    requireStore(m.kind === 'result' && m.id === call.id && typeof m.text === 'string', 'INVALID_RESULT');
    const reply: unknown = JSON.parse(m.text);
    requireStore(isUiJson(reply, 65536) && uiRecord(reply) && typeof reply.ok === 'boolean', 'INVALID_RESULT');
    requireStore(uiKeys(reply, reply.ok ? ['ok', 'value'] : ['ok', 'code']), 'INVALID_RESULT');
    if (!reply.ok && reply.code !== 'CANCELLED') {
      this.stop('GUEST_FAILURE');
      return;
    }
    clearTimeout(this.timer);
    this.current = undefined;
    call.abort.abort();
    call.detach();
    counts.calls--;
    if (call.cancelled || !reply.ok) call.reject(Error('CANCELLED'));
    else call.resolve(reply.value as UiJson);
    this.next();
  }
  invoke(op: ControllerOp, value: UiJson = {}, signal?: AbortSignal): Promise<UiJson> {
    if (this.stopped) return Promise.reject(Error('STOPPED'));
    if (signal?.aborted) return Promise.reject(Error('CANCELLED'));
    requireStore(isUiJson(value, 65536), 'INPUT_LIMIT');
    requireStore(this.queue.length < 16 && counts.calls < 64, 'QUEUE_LIMIT');
    return new Promise((resolve, reject) => {
      const call: Call = {
        id: ++this.sequence,
        op,
        text: JSON.stringify(value),
        resolve,
        reject,
        abort: new AbortController(),
        cancelled: false,
        detach: () => {},
      };
      const cancel = () => {
        if (this.current === call) {
          if (call.cancelled) return;
          call.cancelled = true;
          call.abort.abort();
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.stop('CANCEL_TIMEOUT'), 500);
          this.send({ kind: 'cancel', fence: this.session.fence, id: call.id });
        } else {
          const index = this.queue.indexOf(call);
          if (index >= 0) {
            this.queue.splice(index, 1);
            counts.calls--;
            call.detach();
            reject(Error('CANCELLED'));
          }
        }
      };
      call.detach = () => signal?.removeEventListener('abort', cancel);
      this.queue.push(call);
      counts.calls++;
      signal?.addEventListener('abort', cancel, { once: true });
      this.next();
    });
  }
  private next(): void {
    if (this.stopped || !this.ready || this.current || !this.queue.length) return;
    const call = this.queue.shift()!;
    this.current = call;
    this.rpcCount = 0;
    this.rpcIds.clear();
    this.timer = setTimeout(
      () => this.stop('WATCHDOG_TIMEOUT'),
      call.op === 'decorate' ? 5000 : (this.options.invocationMs ?? 30000),
    );
    this.send({ kind: 'invoke', fence: this.session.fence, id: call.id, op: call.op, text: call.text });
  }
  stop(reason = 'STOPPED'): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.worker.terminate();
    counts.workers--;
    for (const call of [...(this.current ? [this.current] : []), ...this.queue]) {
      call.abort.abort();
      call.detach();
      counts.calls--;
      call.reject(Error(reason));
    }
    this.queue = [];
    this.current = undefined;
    this.options.onStop(reason);
  }
}
