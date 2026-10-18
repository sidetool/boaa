import { publishCoverChange } from './cover-change-events';
import { sourceReadingPreferences } from './source-reading-preferences';
import { COVER_KEEP_MS } from './cache-policy';
import type { CoverStorage } from './persistent-cover-cache';
interface Entry {
  blob: Blob;
  url: string;
  bytes: number;
  time: number;
}
/** Only an actual HTTP 404 is a cacheable error, never auth, transport or abort failures. */
function isMissingCover(error: unknown): boolean {
  let value = error;
  for (let depth = 0; value && typeof value === 'object' && depth < 3; depth++) {
    const { name, status, statusCode, cause } = value as {
      name?: string;
      status?: number;
      statusCode?: number;
      cause?: unknown;
    };
    if (name === 'AbortError' || name === 'TimeoutError') return false;
    if (status !== undefined || statusCode !== undefined) return (status ?? statusCode) === 404;
    value = cause;
  }
  return false;
}
/** Shared blob ownership for installed source adapters. Visible images cannot be evicted. */
export class SessionCoverCache {
  private hydrations = new Map<string, Promise<void>>();
  private invalidations = new Map<string, Promise<void>>();
  private entries = new Map<string, Entry>();
  private retired = new Map<string, Entry>();
  private operations = new Map<string, AbortController>();
  private pending = new Map<string, Promise<string | undefined>>();
  private missing = new Map<string, number>();
  private lifetime = new AbortController();
  private running = 0;
  private queue: Array<() => void> = [];
  private waiters = new Map<string, Set<AbortSignal>>();
  private pins = new Map<string, Map<AbortSignal, () => void>>();
  constructor(
    private maxBytes = 64 * 1024 * 1024,
    private maxEntries = 400,
    private storage?: CoverStorage,
    private readonly preferenceScope?: string,
  ) {}
  /** A permit belongs to actual I/O, even if a loader ignores cancellation. */
  private async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.running >= 4) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.queue.indexOf(start);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        };
        this.queue.push(start);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
    } else this.running++;
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
  /** Synchronous render path; resolve() acquires ownership and refreshes stale entries. */
  peek(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.time + COVER_KEEP_MS <= Date.now()) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.url;
  }
  private hydrate(key: string): Promise<void> {
    let pending = this.hydrations.get(key);
    if (!pending) {
      const lifetime = this.lifetime;
      const source = JSON.parse(key)[0] as string;
      const invalidation = this.invalidations.get(source);
      pending = (async () => {
        await invalidation;
        const saved = await this.storage!.get(key).catch(() => undefined);
        if (
          !saved ||
          lifetime.signal.aborted ||
          invalidation !== this.invalidations.get(source) ||
          this.entries.has(key) ||
          this.missing.has(key)
        )
          return;
        if (saved.missing) {
          this.rememberMissing(key, saved.time);
          return;
        }
        this.trim(saved.blob.size);
        this.entries.set(key, {
          url: URL.createObjectURL(saved.blob),
          bytes: saved.blob.size,
          time: saved.time,
          blob: saved.blob,
        });
      })();
      this.hydrations.set(key, pending);
      void pending
        .finally(() => {
          if (this.hydrations.get(key) === pending) this.hydrations.delete(key);
        })
        .catch(() => undefined);
    }
    return pending;
  }
  private pin(url: string, signal: AbortSignal) {
    if (signal.aborted) return;
    const users = this.pins.get(url) ?? new Map<AbortSignal, () => void>();
    if (users.has(signal)) return;
    const release = () => {
      users.delete(signal);
      if (!users.size) this.pins.delete(url);
    };
    users.set(signal, release);
    this.pins.set(url, users);
    signal.addEventListener('abort', release, { once: true });
  }
  async resolve(
    key: string,
    load: (signal: AbortSignal) => Promise<Blob | undefined>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const lifetime = this.lifetime;
    if (this.storage && !this.entries.has(key) && !this.missing.has(key)) await this.hydrate(key);
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const missingAt = this.missing.get(key);
    if (
      missingAt !== undefined &&
      missingAt + sourceReadingPreferences(this.preferenceScope).coverHours * 3600000 > Date.now()
    )
      return undefined;
    this.missing.delete(key);
    const found = this.entries.get(key);
    if (found) {
      this.entries.delete(key);
      this.entries.set(key, found);
      if (found.time + sourceReadingPreferences(this.preferenceScope).coverHours * 3600000 > Date.now()) {
        this.pin(found.url, signal);
        return found.url;
      }
    }
    const retained = found && found.time + COVER_KEEP_MS > Date.now() ? found : undefined;
    if (retained && typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.pin(retained.url, signal);
      return retained.url;
    }
    const waiters = this.waiters.get(key) ?? new Set<AbortSignal>();
    waiters.add(signal);
    this.waiters.set(key, waiters);
    let request = this.pending.get(key);
    if (!request) {
      const generation = this.lifetime;
      const local = new AbortController();
      this.operations.set(key, local);
      const operation = AbortSignal.any([generation.signal, local.signal, AbortSignal.timeout(30_000)]);
      const abort = () => {
        local.abort(operation.reason);
        if (this.operations.get(key) === local) {
          this.operations.delete(key);
          this.pending.delete(key);
          this.waiters.delete(key);
        }
      };
      operation.addEventListener('abort', abort, { once: true });
      request = (async () => {
        const blob = await this.run(operation, () => load(operation));
        operation.throwIfAborted();
        if (!blob || blob.size === 0) {
          this.storeMissing(key);
          return undefined;
        }
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 16 * 1024 * 1024)
          throw new Error('invalid_source_cover');
        const previous = this.entries.get(key);
        if (previous && previous.blob.size === blob.size && previous.blob.type === blob.type) {
          const hashes = await Promise.all(
            [previous.blob, blob].map(
              async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer())),
            ),
          );
          operation.throwIfAborted();
          if (hashes[0].every((byte, index) => byte === hashes[1][index])) {
            previous.time = Date.now();
            void this.storage?.put(key, blob, previous.time).catch(() => undefined);
            return previous.url;
          }
        }
        if (previous) {
          this.entries.delete(key);
          this.retired.set(previous.url, previous);
        }
        this.trim(blob.size);
        const url = URL.createObjectURL(blob);
        // Protect delivery before the next completed download can evict this URL.
        for (const consumer of waiters) this.pin(url, consumer);
        const time = Date.now();
        this.entries.set(key, { url, bytes: blob.size, time, blob });
        if (previous) publishCoverChange();
        // Storage failures (quota/private browsing) must not prevent image delivery.
        void this.storage?.put(key, blob, time).catch(() => undefined);
        return url;
      })();
      request = request.catch((error) => {
        if (!operation.aborted && isMissingCover(error)) {
          this.storeMissing(key);
          return undefined;
        }
        throw error;
      });
      this.pending.set(key, request);
      void request
        .finally(() => {
          operation.removeEventListener('abort', abort);
          if (this.pending.get(key) === request) {
            this.pending.delete(key);
            this.operations.delete(key);
            this.waiters.delete(key);
          }
        })
        .catch(() => undefined);
    }
    // Retained URLs return immediately, but their consumer owns the refresh until
    // completion or abort. The last owner cancels queued work and the loader signal.
    const local = this.operations.get(key)!;
    const release = () => {
      waiters.delete(signal);
      if (!waiters.size && this.operations.get(key) === local) {
        this.operations.delete(key);
        this.pending.delete(key);
        this.waiters.delete(key);
        local.abort();
      }
    };
    signal.addEventListener('abort', release, { once: true });
    const cleanupOwner = () => {
      signal.removeEventListener('abort', release);
      waiters.delete(signal);
    };
    // Invalidation/clear also release ownership listeners if the loader ignores abort.
    const ownership = AbortSignal.any([local.signal, lifetime.signal]);
    ownership.addEventListener('abort', cleanupOwner, { once: true });
    void request
      .finally(() => {
        cleanupOwner();
        ownership.removeEventListener('abort', cleanupOwner);
      })
      .catch(() => undefined);
    if (retained) {
      void request.catch(() => undefined);
      this.pin(retained.url, signal);
      return retained.url;
    }
    // Reject consumers promptly, without freeing the actual operation's permit.
    const delivery = AbortSignal.any([signal, ownership]);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        cleanup();
        reject(delivery.reason);
      };
      const cleanup = () => delivery.removeEventListener('abort', cancel);
      delivery.addEventListener('abort', cancel, { once: true });
      if (delivery.aborted) cancel();
      request.then(
        (url) => {
          cleanup();
          if (delivery.aborted) reject(delivery.reason);
          else {
            if (url) this.pin(url, signal);
            resolve(url);
          }
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
  private rememberMissing(key: string, time: number) {
    if (this.missing.size >= this.maxEntries) this.missing.delete(this.missing.keys().next().value!);
    this.missing.set(key, time);
  }
  private storeMissing(key: string) {
    const time = Date.now();
    this.rememberMissing(key, time);
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.retired.set(previous.url, previous);
      publishCoverChange();
    }
    void this.storage?.putMissing?.(key, time).catch(() => undefined);
  }
  private trim(incoming: number) {
    let bytes = [...this.entries.values(), ...this.retired.values()].reduce((n, e) => n + e.bytes, 0);
    const visible = new Set(typeof document === 'undefined' ? [] : Array.from(document.images).map((img) => img.src));
    for (const url of this.pins.keys()) visible.add(url);
    for (const [url, entry] of this.retired) {
      if (visible.has(url)) continue;
      URL.revokeObjectURL(url);
      this.retired.delete(url);
      bytes -= entry.bytes;
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxEntries && bytes + incoming <= this.maxBytes) break;
      if (visible.has(entry.url)) continue;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
  }
  invalidateSource(source: string) {
    if (this.storage) {
      const pending = this.storage.invalidateSource(source).catch(() => undefined);
      this.invalidations.set(source, pending);
    }
    const prefix = JSON.stringify([source]).slice(0, -1) + ',';
    for (const [key, operation] of this.operations)
      if (key.startsWith(prefix)) {
        operation.abort();
        this.operations.delete(key);
        this.pending.delete(key);
        this.waiters.delete(key);
      }
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.retired.set(entry.url, entry);
    }
    for (const key of this.missing.keys()) if (key.startsWith(prefix)) this.missing.delete(key);
    this.trim(0);
  }
  clear() {
    this.lifetime.abort();
    this.hydrations.clear();
    this.lifetime = new AbortController();
    for (const users of this.pins.values())
      for (const [signal, release] of users) signal.removeEventListener('abort', release);
    this.pins.clear();
    this.waiters.clear();
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    for (const url of this.retired.keys()) URL.revokeObjectURL(url);
    this.retired.clear();
    this.missing.clear();
    this.entries.clear();
    this.pending.clear();
    this.operations.clear();
  }
}
