import {
  sourceCachePolicy,
  sourcePageTime,
  sourcePageFreshness,
  sourceListIdentity,
  transientSourceFailure,
} from '../../external-sources/cache-policy';
import {
  sourceReadingPreferences,
  sourceReadingPreferenceEvent,
} from '../../external-sources/source-reading-preferences';
import { ExternalSourceLocalStateStore, subscribeSourceCacheClear } from '../../external-sources/local-state';
import { storedSourcePage, restoredSourcePage } from '../../external-sources/cached-page';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type {
  ExternalItemKey,
  ExternalItemPage,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';

interface ListRequest {
  readonly source: string;
  readonly abort: AbortController;
  readonly promise: Promise<ExternalItemPage>;
  readonly task: (reload: boolean) => Promise<ExternalItemPage>;
  reload: boolean;
  readonly revalidating: boolean;
  started: boolean;
  readonly resolve: (page: ExternalItemPage) => void;
  readonly reject: (reason: unknown) => void;
  consumers: number;
}

let sessionSequence = 0;

/** One session, shared by the home and its source sections. Bounded memory and IndexedDB results; no polling. */
export class DiscoverySession {
  readonly instance = ++sessionSequence;
  readonly railPositions = new Map<string, number>();
  readonly scrollPositions = new Map<string, { id?: string; offset: number; top: number }>();
  private cache = new Map<string, { page: ExternalItemPage; time: number; bytes: number }>();
  private restoring = new Map<string, Promise<ExternalItemPage | undefined>>();
  private activeSources = new Set<string>();
  private pending = new Map<string, ListRequest>();
  private running = 0;
  private queue: ListRequest[] = [];
  private readonly storage: ExternalSourceLocalStateStore;
  private lifetime = new AbortController();
  constructor(
    readonly registry: ExternalSourceRegistryPort,
    readonly context: TrustedExternalSourceHostContext,
    readonly scope = 'local',
    storage?: ExternalSourceLocalStateStore,
  ) {
    this.storage =
      storage ??
      new ExternalSourceLocalStateStore(scope.startsWith('hosted-account:') ? scope : undefined, this.lifetime.signal);
  }
  key(source: string, input: ExternalSourceListInput) {
    const status = this.registry.getExternalSourceStatus(source as ExtensionContributionId, this.context);
    return JSON.stringify([
      this.scope,
      source,
      status.state,
      status.accountConnectionId,
      status.connectionGeneration,
      sourceListIdentity(input),
    ]);
  }
  private policy(input: ExternalSourceListInput) {
    return sourceCachePolicy(input, false, this.scope.startsWith('hosted-account:') ? this.scope : undefined);
  }
  peek(source: string, input: ExternalSourceListInput) {
    const policy = this.policy(input);
    if (this.lifetime.signal.aborted || !policy.fresh) return undefined;
    const key = this.key(source, input);
    const cached = this.cache.get(key);
    if (cached && cached.time + policy.keep <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
    }
    return cached;
  }
  async schema(source: string, input: ExternalSourceListInput, refresh = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    refresh ||= input.cacheMode === 'reload';
    const key = `schema:${this.key(source, input)}`;
    let saved = this.cache.get(key);
    if (!saved && typeof indexedDB !== 'undefined') {
      const disk = await this.storage.getCachePage(key).catch(() => undefined);
      if (disk && !this.lifetime.signal.aborted) {
        this.remember(key, restoredSourcePage(disk));
        saved = this.cache.get(key);
      }
    }
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (key !== `schema:${this.key(source, input)}`) throw new Error('package_generation_changed');
    if (saved && saved.time + 7 * 86400_000 <= Date.now()) {
      this.cache.delete(key);
      saved = undefined;
    }
    if (!refresh && saved && !saved.page.cache?.stale && saved.time + 6 * 3600_000 > Date.now()) return saved.page;
    try {
      const page = await this.list(source, input, refresh, signal);
      if (key !== `schema:${this.key(source, input)}`) throw new Error('package_generation_changed');
      const schema = { items: [], browse: page.browse, cache: page.cache };
      this.remember(key, schema);
      if (typeof indexedDB !== 'undefined') {
        const time = sourcePageTime(schema);
        void this.storage
          .saveCachePage({
            ...storedSourcePage(
              key,
              source,
              {
                ...input,
                accountConnectionId: this.registry.getExternalSourceStatus(
                  source as ExtensionContributionId,
                  this.context,
                ).accountConnectionId,
              },
              schema,
              this.scope,
            ),
            expiresAt: new Date(time + (page.cache?.stale ? 0 : 6 * 3600_000)).toISOString(),
            retainUntil: new Date(time + 7 * 86400_000).toISOString(),
          })
          .catch(() => undefined);
      }
      return schema;
    } catch (error) {
      signal?.throwIfAborted();
      if (transientSourceFailure(error)) {
        if (!refresh && saved) return saved.page;
      } else if (!this.lifetime.signal.aborted) await this.forgetPage(key);
      throw error;
    }
  }
  /** Disk-first SWR seed, independent of the list request queue. Concurrent readers share
   * hydration, and a slow disk read can never overwrite a newer network/memory result.
   */
  async restore(source: string, input: ExternalSourceListInput) {
    if (!this.policy(input).fresh) return undefined;
    const key = this.key(source, input);
    const cached = this.peek(source, input);
    if (cached) return cached.page;
    if (typeof indexedDB === 'undefined' || this.lifetime.signal.aborted) return undefined;
    const pending = this.restoring.get(key);
    if (pending) return pending;
    const hydration: Promise<ExternalItemPage | undefined> = this.storage
      .getCachePage(key)
      .catch(() => undefined)
      .then((saved) => {
        if (this.lifetime.signal.aborted || this.restoring.get(key) !== hydration || key !== this.key(source, input))
          return undefined;
        const newer = this.peek(source, input);
        if (newer) return newer.page;
        const policy = this.policy(input);
        if (!saved || !policy.fresh || Date.parse(saved.fetchedAt) + policy.keep <= Date.now()) return undefined;
        const page = restoredSourcePage(saved);
        this.remember(key, page);
        return page;
      });
    this.restoring.set(key, hydration);
    try {
      return await hydration;
    } finally {
      if (this.restoring.get(key) === hydration) this.restoring.delete(key);
    }
  }
  private async forgetPage(key: string) {
    this.restoring.delete(key);
    this.cache.delete(key);
    if (typeof indexedDB !== 'undefined') await this.storage.deleteCachePage(key).catch(() => undefined);
  }
  private remember(key: string, page: ExternalItemPage) {
    this.cache.delete(key);
    this.cache.set(key, {
      page,
      time: sourcePageTime(page),
      bytes: new TextEncoder().encode(JSON.stringify(page)).length,
    });
    let bytes = [...this.cache.values()].reduce((n, v) => n + v.bytes, 0);
    while (this.cache.size > 1000 || bytes > 8 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value!;
      bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }
  async list(
    source: string,
    input: ExternalSourceListInput,
    refresh = false,
    consumerSignal?: AbortSignal,
  ): Promise<ExternalItemPage> {
    const consumer = AbortSignal.any([this.lifetime.signal, ...(consumerSignal ? [consumerSignal] : [])]);
    consumer.throwIfAborted();
    const key = this.key(source, input);
    const cached = this.peek(source, input);
    const ttl = this.policy(input).fresh;
    refresh ||= input.cacheMode === 'reload';
    if (
      !refresh &&
      cached &&
      !cached.page.cache?.stale &&
      Date.now() - cached.time < sourcePageFreshness(ttl, cached.page.items.length)
    )
      return cached.page;
    let entry = this.pending.get(key);
    if (refresh && entry && !entry.reload) {
      // A queued read can be upgraded. An ordinary request already in flight
      // might return from a downstream cache, so queue one shared reload behind it.
      if (entry.started) entry = undefined;
      else entry.reload = true;
    }
    if (!entry) {
      const abort = new AbortController();
      let resolve!: ListRequest['resolve'];
      let reject!: ListRequest['reject'];
      const promise = new Promise<ExternalItemPage>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      entry = {
        source,
        abort,
        promise,
        resolve,
        reject,
        consumers: 0,
        reload: refresh,
        revalidating: Boolean(cached) && !refresh,
        started: false,
        task: async (reload) => {
          const signal = AbortSignal.any([this.lifetime.signal, abort.signal, AbortSignal.timeout(30_000)]);
          signal.throwIfAborted();
          if (key !== this.key(source, input)) throw new Error('소스 연결이 변경되었습니다. 다시 열어 주세요.');
          const status = this.registry.getExternalSourceStatus(source as ExtensionContributionId, this.context);
          if (status.state !== 'connected') throw new Error('소스 연결을 확인해 주세요.');
          const received = await this.registry
            .listExternalSource(
              source as ExtensionContributionId,
              this.context,
              {
                ...input,
                accountConnectionId: status.accountConnectionId,
                cacheMaxAgeMs: ttl,
                ...(reload ? { cacheMode: 'reload' as const } : {}),
              },
              signal,
            )
            .catch(async (error: unknown) => {
              if (!signal.aborted && !transientSourceFailure(error)) await this.forgetPage(key);
              throw error;
            });
          signal.throwIfAborted();
          if (key !== this.key(source, input)) throw new Error('소스 연결이 변경되었습니다. 다시 열어 주세요.');
          const page = { ...received, cache: { ...received.cache, fetchedAt: sourcePageTime(received) } };
          this.remember(key, page);
          if (typeof indexedDB !== 'undefined')
            void this.storage
              .saveCachePage(
                storedSourcePage(
                  key,
                  source,
                  { ...input, accountConnectionId: status.accountConnectionId },
                  page,
                  this.scope,
                ),
              )
              .catch(() => undefined);
          return page;
        },
      };
      this.pending.set(key, entry);
      this.queue.push(entry);
      const request = entry;
      void promise.then(
        () => this.forget(key, request),
        () => this.forget(key, request),
      );
    }
    const request = entry;
    request.consumers++;
    const result = new Promise<ExternalItemPage>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        consumer.removeEventListener('abort', cancel);
        request.consumers--;
        complete();
      };
      const cancel = () =>
        finish(() => {
          reject(consumer.reason);
          // Once a retained page is refreshing, a route change releases its
          // caller immediately while the bounded session-owned fill can finish.
          if (!request.consumers && !(request.revalidating && request.started)) {
            request.abort.abort(consumer.reason);
            this.forget(key, request);
            const index = this.queue.indexOf(request);
            if (index >= 0) {
              this.queue.splice(index, 1);
              request.reject(consumer.reason);
            }
          }
        });
      consumer.addEventListener('abort', cancel, { once: true });
      void request.promise.then(
        (page) => finish(() => resolve(page)),
        (error) => finish(() => reject(error)),
      );
      if (consumer.aborted) cancel();
    });
    this.pump();
    return result;
  }
  private forget(key: string, request: ListRequest) {
    if (this.pending.get(key) === request) this.pending.delete(key);
  }
  private pump() {
    while (this.running < 2) {
      const index = this.queue.findIndex((request) => !this.activeSources.has(request.source));
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0]!;
      request.started = true;
      this.running++;
      this.activeSources.add(request.source);
      // An aborting consumer may leave immediately, but a loader that ignores abort
      // keeps both its source and global permit until its actual promise settles.
      void request
        .task(request.reload)
        .then(request.resolve, request.reject)
        .finally(() => {
          this.running--;
          this.activeSources.delete(request.source);
          this.pump();
        });
    }
  }
  private coverRunning = 0;
  private coverQueue: Array<() => void> = [];
  peekCover(key: ExternalItemKey) {
    return this.registry.peekExternalSourceCover?.(key.connectorId as ExtensionContributionId, this.context, key);
  }
  async cover(key: ExternalItemKey, signal: AbortSignal) {
    const cached = this.peekCover(key);
    const consumer = AbortSignal.any([signal, this.lifetime.signal, ...(cached ? [] : [AbortSignal.timeout(30_000)])]);
    consumer.throwIfAborted();
    const resolve = () =>
      this.registry.resolveExternalSourceCover?.(
        key.connectorId as ExtensionContributionId,
        this.context,
        key,
        consumer,
      );
    // Cached display stays immediate. SessionCoverCache separately bounds actual
    // fills/revalidation across sessions, including loaders that ignore abort.
    if (cached) return resolve();
    // Keep admission bounded for registry implementations without a shared cache.
    if (this.coverRunning >= 4) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          consumer.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.coverQueue.indexOf(start);
          if (index >= 0) this.coverQueue.splice(index, 1);
          reject(consumer.reason);
        };
        this.coverQueue.push(start);
        consumer.addEventListener('abort', cancel, { once: true });
        if (consumer.aborted) cancel();
      });
    } else this.coverRunning++;
    try {
      consumer.throwIfAborted();
      return await resolve();
    } finally {
      const next = this.coverQueue.shift();
      if (next) next();
      else this.coverRunning--;
    }
  }
  private cleanup?: ReturnType<typeof setTimeout>;
  mount(onCacheClear: () => void) {
    clearTimeout(this.cleanup);
    const reset = () => {
      if (this.lifetime.signal.aborted) return;
      this.dispose();
      onCacheClear();
    };
    const unsubscribe = subscribeSourceCacheClear((scope) => {
      if (scope === this.storage.scope) reset();
    });
    const preferenceScope = this.scope.startsWith('hosted-account:') ? this.scope : undefined;
    const initialMinutes = sourceReadingPreferences(preferenceScope).listMinutes;
    const onPreferences = () => {
      if (sourceReadingPreferences(preferenceScope).listMinutes !== initialMinutes) reset();
    };
    globalThis.window?.addEventListener?.(sourceReadingPreferenceEvent, onPreferences);
    globalThis.window?.addEventListener?.('storage', onPreferences);
    return () => {
      unsubscribe();
      globalThis.window?.removeEventListener?.(sourceReadingPreferenceEvent, onPreferences);
      globalThis.window?.removeEventListener?.('storage', onPreferences);
      this.cleanup = setTimeout(() => this.dispose(), 0);
    };
  }
  dispose() {
    this.lifetime.abort();
    this.cache.clear();
    this.restoring.clear();
    this.railPositions.clear();
    this.scrollPositions.clear();
  }
}
