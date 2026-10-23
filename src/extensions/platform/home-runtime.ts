import { validateHomeFeed, type HomeFeed } from '../../../packages/extension-contracts/home-feed';
import { uiRecord, type UiJson } from '@boaa/extension-contracts/ui-json';
import { requireStore } from '../ui/store-model';
import type { Installation } from './store-model';
import type { PluginHttp } from './plugin-http';

interface Host {
  list(): Promise<Installation[]>;
  invoke(row: Installation, section: string, signal?: AbortSignal): Promise<UiJson>;
}
interface Owned {
  pluginId: string;
  identity: string;
}
export interface HomeSnapshot {
  page: HomeFeed;
  freshUntil: number;
  savedAt: number;
}
interface CoverOperation extends Owned {
  abort: AbortController;
  promise: Promise<string>;
  consumers: number;
  settled: boolean;
}
const identity = (row: Installation) => JSON.stringify([row.installationId, row.active, row.revision]);
const feedKey = (id: string, section: string) => JSON.stringify([id, section]);
const enabled = (row: Installation) => row.enabled && !row.tombstone;

/** Host-owned home data and artwork leases; never runs guest code outside the controller service. */
export class PluginHomeRuntime {
  private feeds = new Map<string, Owned & { feed: HomeFeed }>();
  private covers = new Map<string, Owned & { url: string }>();
  private pending = new Map<string, CoverOperation>();
  private closed = false;
  private unwatch?: () => void;
  constructor(
    private readonly host: Host,
    private readonly http?: PluginHttp,
    private readonly off = false,
  ) {
    this.unwatch = http?.subscribeConnections?.(() => {
      for (const cover of this.covers.values()) URL.revokeObjectURL(cover.url);
      this.covers.clear();
    });
  }
  coverSnapshot(id: string, section: string, url: string): string | undefined {
    if (this.closed) return undefined;
    const feed = this.feeds.get(feedKey(id, section));
    if (!feed?.feed.items.some((item) => item.coverUrl === url)) return undefined;
    for (const [key, value] of this.covers)
      if (value.pluginId === id && value.identity === feed.identity && JSON.parse(key)[3] === url) return value.url;
    return undefined;
  }
  private guard(signal?: AbortSignal) {
    requireStore(!this.closed && !this.off, 'PLUGINS_DISABLED');
    signal?.throwIfAborted();
  }
  private async row(id: string, signal?: AbortSignal) {
    this.guard(signal);
    const row = (await this.host.list()).find((item) => item.pluginId === id && enabled(item));
    this.guard(signal);
    requireStore(row, 'PACKAGE_UNAVAILABLE');
    return row;
  }
  async sections() {
    if (this.closed || this.off) return [];
    const rows = await this.host.list();
    if (this.closed) return [];
    return rows.filter(enabled).flatMap((row) =>
      (row.manifest?.contributes.homeSections ?? []).map((section) => ({
        pluginId: row.pluginId,
        installationId: row.installationId,
        digest: row.active!,
        revision: row.revision,
        pluginName: row.manifest!.extension.name,
        section,
      })),
    );
  }
  async feed(id: string, section: string, signal?: AbortSignal): Promise<HomeFeed> {
    const row = await this.row(id, signal);
    requireStore(
      row.manifest?.contributes.homeSections?.some((item) => item.id === section),
      'UNKNOWN_HOME_FEED',
    );
    const result = await this.host.invoke(row, section, signal);
    this.guard(signal);
    requireStore(uiRecord(result) && result.ok === true, 'HOME_FEED_FAILED');
    const feed = validateHomeFeed(result.value);
    this.feeds.set(feedKey(id, section), { pluginId: id, identity: identity(row), feed });
    if (this.http?.cache) {
      await this.http.cache
        .host(
          this.http.owner(row),
          'home',
          'controller',
          {
            action: 'set',
            key: section,
            value: feed as unknown as UiJson,
            ttlSeconds: Math.max(60, Math.min(feed.ttlSeconds ?? 1800, 86400)),
            staleSeconds: 86400,
          },
          signal,
        )
        .catch(() => {});
      this.guard(signal);
    }
    return feed;
  }
  async snapshot(id: string, section: string, signal?: AbortSignal): Promise<HomeSnapshot | null | undefined> {
    if (!this.http?.cache) return undefined;
    const row = await this.row(id, signal);
    try {
      const result = await this.http.cache.host(
        this.http.owner(row),
        'home',
        'controller',
        { action: 'get', key: section },
        signal,
      );
      this.guard(signal);
      const current = await this.row(id, signal);
      requireStore(identity(row) === identity(current), 'CONTEXT_STALE');
      if (!result.found) return null;
      const page = validateHomeFeed(result.value);
      this.feeds.set(feedKey(id, section), { pluginId: id, identity: identity(row), feed: page });
      return { page, freshUntil: result.freshUntil, savedAt: result.savedAt };
    } catch {
      this.guard(signal);
      return undefined;
    }
  }
  private authorizeCover(row: Installation, section: string | undefined, url: string) {
    const feeds = section === undefined ? [...this.feeds.values()] : [this.feeds.get(feedKey(row.pluginId, section))];
    requireStore(
      feeds.some(
        (feed) =>
          feed?.pluginId === row.pluginId &&
          feed.identity === identity(row) &&
          feed.feed.items.some((item) => item.coverUrl === url),
      ) && this.http,
      'HOME_COVER_DENIED',
    );
  }
  async cover(id: string, section: string, url: string, signal?: AbortSignal): Promise<string> {
    const row = await this.row(id, signal);
    this.authorizeCover(row, section, url);
    // Even a local Blob hit must respect current connection consent.
    const connections = await this.http!.list(row);
    this.guard(signal);
    requireStore(identity(await this.row(id, signal)) === identity(row), 'CONTEXT_STALE');
    const target = new URL(url);
    const connection = connections.find(
      (c) =>
        c.roles.includes('controller') &&
        c.methods.includes('GET') &&
        target.origin === new URL(c.endpoint).origin &&
        target.pathname.startsWith(new URL(c.endpoint).pathname),
    );
    if (!connection) {
      for (const [key, cover] of this.covers)
        if (cover.pluginId === id) {
          URL.revokeObjectURL(cover.url);
          this.covers.delete(key);
        }
    }
    requireStore(connection, 'HOME_COVER_DENIED');
    const key = JSON.stringify([id, identity(row), connection.revision, url]);
    for (const [oldKey, cover] of this.covers)
      if (cover.pluginId === id && oldKey !== key && JSON.parse(oldKey)[3] === url) {
        URL.revokeObjectURL(cover.url);
        this.covers.delete(oldKey);
      }
    const cached = this.covers.get(key);
    if (cached) {
      this.covers.delete(key);
      this.covers.set(key, cached);
      return cached.url;
    }
    let operation = this.pending.get(key);
    if (!operation || operation.abort.signal.aborted) {
      const abort = new AbortController();
      operation = {
        pluginId: id,
        identity: identity(row),
        abort,
        consumers: 0,
        settled: false,
        promise: Promise.resolve(''),
      };
      const current = operation;
      current.promise = this.loadCover(row, url, key, abort.signal).finally(() => {
        current.settled = true;
        if (this.pending.get(key) === current) this.pending.delete(key);
      });
      this.pending.set(key, current);
    }
    return this.consume(operation, signal);
  }
  private consume(operation: CoverOperation, signal?: AbortSignal): Promise<string> {
    operation.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (ok: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        if (--operation.consumers === 0 && !operation.settled) operation.abort.abort();
        if (ok) resolve(value as string);
        else reject(value);
      };
      const abort = () => finish(false, signal?.reason ?? Error('CANCELLED'));
      signal?.addEventListener('abort', abort, { once: true });
      operation.promise.then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
      if (signal?.aborted) abort();
    });
  }
  private async loadCover(row: Installation, url: string, key: string, signal: AbortSignal) {
    const value = await this.http!.host('cover', this.http!.owner(row), { url }, signal);
    this.guard(signal);
    const current = await this.row(row.pluginId, signal);
    requireStore(identity(current) === identity(row), 'CONTEXT_STALE');
    this.authorizeCover(current, undefined, url);
    const connections = await this.http!.list(current);
    requireStore(
      connections.some(
        (c) => c.revision === JSON.parse(key)[2] && c.roles.includes('controller') && c.methods.includes('GET'),
      ),
      'HOME_COVER_DENIED',
    );
    this.guard(signal);
    requireStore(
      uiRecord(value) &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mime)) &&
        typeof value.data === 'string' &&
        value.data.length > 0 &&
        value.data.length < 700000,
      'INVALID_COVER',
    );
    const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
    requireStore(bytes.length > 0 && bytes.length <= 512 * 1024, 'INVALID_COVER');
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: String(value.mime) }));
    if (this.covers.size >= 100) {
      const oldest = this.covers.keys().next().value!;
      URL.revokeObjectURL(this.covers.get(oldest)!.url);
      this.covers.delete(oldest);
    }
    this.covers.set(key, { pluginId: row.pluginId, identity: identity(row), url: objectUrl });
    return objectUrl;
  }
  /** Changes to another plugin must not revoke artwork still displayed by this installation. */
  reconcile(rows: readonly Installation[]) {
    const current = new Map(rows.filter(enabled).map((row) => [row.pluginId, identity(row)]));
    const stale = (value: Owned) => current.get(value.pluginId) !== value.identity;
    for (const [key, value] of this.feeds) if (stale(value)) this.feeds.delete(key);
    for (const [key, value] of this.covers)
      if (stale(value)) {
        URL.revokeObjectURL(value.url);
        this.covers.delete(key);
      }
    for (const [key, value] of this.pending)
      if (stale(value)) {
        value.abort.abort();
        this.pending.delete(key);
      }
  }
  close() {
    this.closed = true;
    this.unwatch?.();
    this.feeds.clear();
    for (const value of this.covers.values()) URL.revokeObjectURL(value.url);
    this.covers.clear();
    for (const value of this.pending.values()) value.abort.abort();
    this.pending.clear();
  }
}
