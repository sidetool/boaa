import { isUiJson, uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
import {
  PLUGIN_IMAGE_BYTES,
  PLUGIN_IMAGE_REPLY_BYTES,
  pluginImageRequest,
  type PluginImageInput,
} from '../../../../packages/extension-contracts/plugin-images';
interface Entry {
  key: string;
  url: string;
  revision: string;
  bytes: number;
  pixels: number;
  refs: number;
  time: number;
  revoked: boolean;
}
interface Operation {
  key: string;
  input: PluginImageInput;
  abort: AbortController;
  consumers: number;
  promise: Promise<Entry>;
  resolve(value: Entry): void;
  reject(error: unknown): void;
  started: boolean;
}
export const IMAGE_CACHE_LIMITS = Object.freeze({
  entries: 24,
  bytes: 4 * 1024 * 1024,
  decodedBytes: 12 * 1024 * 1024,
  consumers: 64,
  queued: 32,
  active: 2,
  ttlMs: 300000,
});
/** Frame-local image leases. Every acquisition rechecks server consent, including cached images. */
export class PluginImages {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Operation>();
  private queue: Operation[] = [];
  private active = 0;
  private consumers = 0;
  private closed = false;
  private wake?: ReturnType<typeof setTimeout>;
  constructor(
    private request: (method: string, input: UiJson, signal?: AbortSignal) => Promise<UiJson>,
    private available: () => boolean = () => true,
  ) {}
  async load(input: PluginImageInput, signal?: AbortSignal): Promise<{ url: string; dispose(): void }> {
    if (this.closed) throw Error('VIEW_CLOSED');
    signal?.throwIfAborted();
    if (!pluginImageRequest(input) || !uiKeys(input as unknown as Record<string, UiJson>, ['slot', 'path']))
      throw Error('INVALID_IMAGE_REQUEST');
    if (this.consumers >= IMAGE_CACHE_LIMITS.consumers) throw Error('IMAGE_LIMIT');
    const key = JSON.stringify([input.slot, input.path]);
    let operation = this.pending.get(key);
    if (operation?.abort.signal.aborted) operation = undefined;
    if (!operation) {
      if (this.pending.size >= IMAGE_CACHE_LIMITS.queued) throw Error('IMAGE_LIMIT');
      let resolve!: (entry: Entry) => void, reject!: (error: unknown) => void;
      const promise = new Promise<Entry>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      operation = {
        key,
        input: { slot: input.slot, path: input.path },
        abort: new AbortController(),
        consumers: 0,
        promise,
        resolve,
        reject,
        started: false,
      };
      this.pending.set(key, operation);
      this.queue.push(operation);
    }
    const current = operation;
    current.consumers++;
    this.consumers++;
    // Subscribe before pumping: synchronous failures must never become unhandled rejections.
    const result = new Promise<{ url: string; dispose(): void }>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        current.consumers--;
        if (current.consumers === 0 && this.pending.get(key) === current) {
          current.abort.abort();
          if (!current.started) {
            this.pending.delete(key);
            this.queue = this.queue.filter((queued) => queued !== current);
            current.reject(Error('CANCELLED'));
          }
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        this.consumers--;
        finish();
        signal?.removeEventListener('abort', abort);
        reject(Error('CANCELLED'));
        this.pump();
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (entry) => {
          if (settled) return;
          if (this.closed || signal?.aborted || entry.revoked) {
            abort();
            return;
          }
          settled = true;
          finish();
          signal?.removeEventListener('abort', abort);
          entry.refs++;
          let disposed = false;
          const dispose = () => {
            if (disposed) return;
            disposed = true;
            entry.refs--;
            this.consumers--;
            signal?.removeEventListener('abort', dispose);
          };
          signal?.addEventListener('abort', dispose, { once: true });
          resolve(Object.freeze({ url: entry.url, dispose }));
        },
        (error) => {
          if (settled) return;
          settled = true;
          finish();
          this.consumers--;
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal?.aborted) abort();
    });
    this.pump();
    return result;
  }
  private pump() {
    clearTimeout(this.wake);
    if (this.closed) return;
    while (this.queue.length && this.active < IMAGE_CACHE_LIMITS.active) {
      if (!this.available()) {
        this.wake = setTimeout(() => this.pump(), 20);
        return;
      }
      const op = this.queue.shift()!;
      if (op.abort.signal.aborted) {
        if (this.pending.get(op.key) === op) this.pending.delete(op.key);
        op.reject(Error('CANCELLED'));
        continue;
      }
      op.started = true;
      this.active++;
      void this.obtain(op)
        .then((entry) => {
          op.resolve(entry);
          queueMicrotask(() => {
            entry.refs--;
          });
        }, op.reject)
        .finally(() => {
          this.active--;
          if (this.pending.get(op.key) === op) this.pending.delete(op.key);
          this.pump();
        });
    }
  }
  private remove(entry: Entry) {
    if (entry.revoked) return;
    entry.revoked = true;
    URL.revokeObjectURL(entry.url);
    if (this.cache.get(entry.key) === entry) this.cache.delete(entry.key);
  }
  private room(bytes: number, pixels: number) {
    const total = () =>
      [...this.cache.values()].reduce((sum, e) => ({ bytes: sum.bytes + e.bytes, pixels: sum.pixels + e.pixels }), {
        bytes: 0,
        pixels: 0,
      });
    while (true) {
      const used = total();
      if (
        this.cache.size < IMAGE_CACHE_LIMITS.entries &&
        used.bytes + bytes <= IMAGE_CACHE_LIMITS.bytes &&
        (used.pixels + pixels) * 4 <= IMAGE_CACHE_LIMITS.decodedBytes
      )
        return;
      const oldest = [...this.cache.values()].find((e) => e.refs === 0);
      if (!oldest) throw Error('IMAGE_LIMIT');
      this.remove(oldest);
    }
  }
  private async obtain(op: Operation): Promise<Entry> {
    const previous = this.cache.get(op.key);
    // Keep a cached candidate resident while the server revalidates it; another
    // image finishing concurrently must not evict the bytes behind notModified.
    if (previous) previous.refs++;
    try {
      op.abort.signal.throwIfAborted();
      const value = await this.request(
        'http.image',
        {
          ...op.input,
          ...(previous && Date.now() - previous.time < IMAGE_CACHE_LIMITS.ttlMs
            ? { cachedRevision: previous.revision }
            : {}),
        },
        op.abort.signal,
      );
      if (this.closed) throw Error('VIEW_CLOSED');
      op.abort.signal.throwIfAborted();
      if (
        !isUiJson(value, PLUGIN_IMAGE_REPLY_BYTES) ||
        !uiRecord(value) ||
        typeof value.revision !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(value.revision)
      )
        throw Error('INVALID_IMAGE');
      if (value.notModified === true) {
        if (
          !uiKeys(value, ['notModified', 'revision']) ||
          !previous ||
          previous.revoked ||
          value.revision !== previous.revision
        )
          throw Error('INVALID_IMAGE');
        this.cache.delete(op.key);
        this.cache.set(op.key, previous);
        previous.refs++;
        return previous;
      }
      if (
        !uiKeys(value, ['mime', 'data', 'width', 'height', 'revision']) ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mime)) ||
        typeof value.data !== 'string' ||
        !value.data.length ||
        value.data.length > Math.ceil(PLUGIN_IMAGE_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) ||
        value.data.length % 4 !== 0 ||
        !uiInteger(value.width, 1, 480) ||
        !uiInteger(value.height, 1, 720)
      )
        throw Error('INVALID_IMAGE');
      const bytes = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
      if (!bytes.length || bytes.length > PLUGIN_IMAGE_BYTES) throw Error('IMAGE_LIMIT');
      const pixels = value.width * value.height;
      // Revalidation must not revoke another consumer's live lease. For an unchanged
      // connection, defer replacing its displayed bytes until all leases are released.
      if (previous && !previous.revoked && previous.refs > 1 && previous.revision === value.revision) {
        previous.time = Date.now();
        previous.refs++;
        this.cache.delete(op.key);
        this.cache.set(op.key, previous);
        return previous;
      }
      if (previous) this.remove(previous);
      this.room(bytes.length, pixels);
      op.abort.signal.throwIfAborted();
      const entry: Entry = {
        key: op.key,
        url: URL.createObjectURL(new Blob([bytes], { type: String(value.mime) })),
        revision: value.revision,
        bytes: bytes.length,
        pixels,
        refs: 1,
        time: Date.now(),
        revoked: false,
      };
      this.cache.set(op.key, entry);
      return entry;
    } catch (error) {
      // A denied cached acquisition must not leave that connection's old image reusable.
      if (previous && !op.abort.signal.aborted) this.remove(previous);
      throw error;
    } finally {
      if (previous) previous.refs--;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.wake);
    for (const op of this.pending.values()) {
      op.abort.abort();
      if (!op.started) op.reject(Error('VIEW_CLOSED'));
    }
    this.queue = [];
    this.pending.clear();
    for (const entry of this.cache.values()) this.remove(entry);
  }
}
