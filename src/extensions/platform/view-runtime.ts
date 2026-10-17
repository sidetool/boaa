import type { PluginHttp } from './plugin-http';
import { isUiJson, uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
import { canonicalJson, requireStore } from '../ui/store-model';
import { requireEnvironment } from '../ui/runtime-policy';
import { PlatformPluginStore } from './plugin-store';
import type { PluginSession } from './store-model';
import type { PluginService } from './plugin-service';
import { RuntimeOwners } from './runtime-owners';
import { validateSettingsSchema } from './settings-schema';
const configDto = (row: Awaited<ReturnType<PlatformPluginStore['readConfig']>>): UiJson =>
  row ? { schemaVersion: row.schema.version, revision: row.revision, value: row.value } : null;
export interface PluginView {
  readonly ready: Promise<void>;
  close(): Promise<void>;
}
/** V3 UI role only. V2 remains on UiPluginRuntime and never inherits V3 grants. */
export class PluginViewRuntime {
  private views = new Map<string, View>();
  private owners = new RuntimeOwners();
  private closed = false;
  constructor(
    private readonly store: PlatformPluginStore,
    private readonly service: PluginService,
    private readonly options: {
      window: Window;
      shellUrl: string;
      deployment: 'self-host' | 'static' | 'native';
      off?: boolean;
      http?: PluginHttp;
    },
  ) {}
  async open(id: string, view: string, container: HTMLElement, signal?: AbortSignal): Promise<PluginView> {
    requireEnvironment(this.options.window, this.options.deployment);
    requireStore(!this.closed && !this.options.off && !signal?.aborted, 'VIEW_UNAVAILABLE');
    requireStore(
      container.isConnected && container.ownerDocument === this.options.window.document,
      'INVALID_CONTAINER',
    );
    const key = JSON.stringify([id, view]);
    requireStore(!this.views.has(key) && this.views.size < 3, 'VIEW_LIMIT');
    const url = new URL(this.options.shellUrl, this.options.window.location.href);
    requireStore(
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'INVALID_SHELL',
    );
    const instance = new View(
      this.store,
      this.service,
      this.owners,
      this.options.window,
      container,
      url.href,
      id,
      view,
      () => this.views.delete(key),
      this.options.http,
    );
    this.views.set(key, instance);
    const abort = () => {
      void instance.close().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    instance.detach = () => signal?.removeEventListener('abort', abort);
    try {
      await instance.start();
      return instance;
    } catch (error) {
      await instance.close(false).catch(() => {});
      throw error;
    }
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.views.values()].map((v) => v.close()));
    this.owners.close();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
class View implements PluginView {
  private session?: PluginSession;
  private frame?: HTMLIFrameElement;
  private port?: MessagePort;
  private stopped = false;
  private cleanup?: Promise<void>;
  private closeLease?: () => Promise<void>;
  private hello?: (event: MessageEvent) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private busy = false;
  private subscriptions = new Map<number, number>();
  private phase: 'hello' | 'bound' | 'loading' | 'ready' = 'hello';
  private lastId = 0;
  private pending = new Map<number, AbortController>();
  private burst = 0;
  private tick = Date.now();
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  detach = () => {};
  constructor(
    private store: PlatformPluginStore,
    private service: PluginService,
    private owners: RuntimeOwners,
    private win: Window,
    private container: HTMLElement,
    private url: string,
    private id: string,
    private view: string,
    private release: () => void,
    private http?: PluginHttp,
  ) {
    void this.ready.catch(() => {});
  }
  private guard() {
    requireStore(!this.stopped && this.container.isConnected, 'VIEW_CLOSED');
  }
  private preparation?: Promise<void>;
  async start() {
    this.preparation = this.prepare();
    await this.preparation;
    return this.ready;
  }
  private async prepare() {
    const row = (await this.store.list()).find((r) => r.pluginId === this.id && !r.tombstone);
    this.guard();
    requireStore(row?.enabled && row.manifest && row.manifest.contributes.views.includes(this.view), 'UNKNOWN_VIEW');
    await this.owners.assertLive(
      (await this.store.unfinishedMarkers()).filter((m) => m.pluginId === this.id).map((m) => m.instanceId),
    );
    this.guard();
    if (row.manifest.entries.controller) {
      const lease = await this.service.openView(this.id, this.view);
      if (this.stopped) {
        await lease();
        throw Error('VIEW_CLOSED');
      }
      this.closeLease = lease;
    }
    const session = await this.store.openSession(this.id, 'ui', row.revision);
    if (this.stopped) {
      this.store.closeSession(session);
      throw Error('VIEW_CLOSED');
    }
    this.session = session;
    await this.store.assertSession(session, session.fence, 'ui.render');
    const source = await this.store.loadEntry(session);
    this.guard();
    await this.store.startMarker(session);
    // A close racing marker commit must still await preparation before marker cleanup.
    this.guard();
    this.owners.add(session.fence.instanceId);
    const frame = this.win.document.createElement('iframe');
    this.frame = frame;
    frame.title = 'Plugin: ' + this.id;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute(
      'allow',
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
    );
    let loads = 0;
    const fail = () => {
      void this.close(false).catch(() => {});
    };
    frame.addEventListener('load', () => {
      if (++loads > 1) fail();
    });
    frame.addEventListener('error', fail);
    this.hello = (event) => {
      if (event.source !== frame.contentWindow) return;
      if (
        event.origin !== 'null' ||
        this.phase !== 'hello' ||
        !isUiJson(event.data, 4096) ||
        !uiRecord(event.data) ||
        !uiKeys(event.data, ['kind', 'nonce']) ||
        event.data.kind !== 'hello' ||
        typeof event.data.nonce !== 'string' ||
        !/^[a-f0-9]{32}$/.test(event.data.nonce)
      ) {
        fail();
        return;
      }
      this.phase = 'bound';
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessageerror = fail;
      this.port.onmessage = ({ data }) => {
        void this.message(data, source).catch(fail);
      };
      this.port.start();
      frame.contentWindow!.postMessage({ kind: 'bind', nonce: event.data.nonce, fence: session.fence }, '*', [
        channel.port2,
      ]);
    };
    this.win.addEventListener('message', this.hello);
    this.timer = setTimeout(fail, 5000);
    this.poll = setInterval(() => {
      if (this.busy || this.stopped) return;
      this.busy = true;
      void this.store
        .assertSession(session, session.fence, 'ui.render')
        .then(async () => {
          this.guard();
          if (!this.subscriptions.size) return;
          const value = configDto(await this.store.readConfig(session));
          this.guard();
          requireStore(isUiJson(value, 65536), 'OUTPUT_LIMIT');
          const revision = value && typeof value === 'object' && !Array.isArray(value) ? (value.revision as number) : 0;
          for (const [subscription, previous] of this.subscriptions) {
            if (revision <= previous) continue;
            this.subscriptions.set(subscription, revision);
            this.send({ kind: 'settings.changed', subscription, value });
          }
        })
        .catch(() => this.close())
        .catch(() => {})
        .finally(() => {
          this.busy = false;
        });
    }, 500);
    frame.src = this.url;
    this.container.append(frame);
  }
  private send(data: Record<string, UiJson>) {
    if (!this.stopped) this.port?.postMessage({ ...data, fence: this.session!.fence });
  }
  private async message(data: unknown, source: string) {
    if (this.stopped) return;
    requireStore(isUiJson(data, 70 * 1024) && uiRecord(data), 'INVALID_MESSAGE');
    const session = this.session!;
    requireStore(
      canonicalJson(data.fence as UiJson) === canonicalJson(session.fence as unknown as UiJson),
      'CONTEXT_STALE',
    );
    if (data.kind === 'bound') {
      requireStore(this.phase === 'bound' && uiKeys(data, ['kind', 'fence']), 'INVALID_STATE');
      this.phase = 'loading';
      await this.store.assertSession(session, session.fence, 'ui.render');
      this.guard();
      this.send({ kind: 'code', source, view: this.view });
      return;
    }
    if (data.kind === 'ready') {
      requireStore(this.phase === 'loading' && uiKeys(data, ['kind', 'fence']), 'INVALID_STATE');
      this.phase = 'ready';
      await this.store.assertSession(session, session.fence, 'ui.render');
      this.guard();
      this.phase = 'ready';
      clearTimeout(this.timer);
      this.resolve();
      return;
    }
    if (Date.now() - this.tick > 1000) {
      this.tick = Date.now();
      this.burst = 0;
    }
    requireStore(++this.burst <= 50, 'CALL_LIMIT');
    if (data.kind === 'cancel') {
      requireStore(uiKeys(data, ['kind', 'fence', 'id']) && uiInteger(data.id, 1, this.lastId), 'INVALID_CALL');
      this.pending.get(data.id)?.abort();
      return;
    }
    requireStore(
      (this.phase === 'loading' || this.phase === 'ready') &&
        data.kind === 'call' &&
        uiKeys(data, ['kind', 'fence', 'id', 'method', 'input']) &&
        uiInteger(data.id, 1, Number.MAX_SAFE_INTEGER) &&
        data.id > this.lastId &&
        typeof data.method === 'string',
      'INVALID_CALL',
    );
    this.lastId = data.id;
    requireStore(this.pending.size < 4, 'CALL_LIMIT');
    const operation = new AbortController();
    this.pending.set(data.id, operation);
    const timeout = setTimeout(() => operation.abort(), data.method === 'http.request' ? 25000 : 5000);
    let result: UiJson;
    let createdSubscription: number | undefined;
    try {
      await this.store.assertCall(session, session.fence, data.method);
      this.guard();
      operation.signal.throwIfAborted();
      const input = data.input;
      requireStore(uiRecord(input), 'INVALID_ARGUMENT');
      let value: UiJson;
      if (data.method === 'http.request') {
        requireStore(this.http, 'HTTP_UNAVAILABLE');
        value = await this.http.request(session, input, operation.signal);
      } else if (data.method === 'controller.call') {
        requireStore(uiKeys(input, ['handler', 'value']) && typeof input.handler === 'string', 'INVALID_ARGUMENT');
        value = await this.service.callFromView(session, input.handler, input.value, operation.signal);
      } else if (data.method === 'settings.watch' || data.method === 'settings.unwatch') {
        requireStore(
          uiKeys(input, ['subscription']) && uiInteger(input.subscription, 1, Number.MAX_SAFE_INTEGER),
          'INVALID_ARGUMENT',
        );
        if (data.method === 'settings.unwatch') {
          this.subscriptions.delete(input.subscription);
          value = null;
        } else {
          const row = await this.store.readConfig(session);
          this.guard();
          operation.signal.throwIfAborted();
          requireStore(
            !this.subscriptions.has(input.subscription) && this.subscriptions.size < 8,
            'SUBSCRIPTION_LIMIT',
          );
          value = configDto(row);
          requireStore(isUiJson(value, 65536), 'OUTPUT_LIMIT');
          this.subscriptions.set(input.subscription, row?.revision ?? 0);
          createdSubscription = input.subscription;
        }
      } else if (data.method === 'settings.get') {
        requireStore(uiKeys(input, []), 'INVALID_ARGUMENT');
        value = configDto(await this.store.readConfig(session));
      } else if (data.method === 'settings.register') {
        requireStore(uiKeys(input, ['schema']), 'INVALID_ARGUMENT');
        validateSettingsSchema(input.schema);
        value = configDto(await this.store.registerSettings(session, input.schema));
      } else if (data.method === 'settings.set') {
        requireStore(
          uiKeys(input, ['expectedRevision', 'value']) &&
            uiInteger(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) &&
            uiRecord(input.value),
          'INVALID_ARGUMENT',
        );
        const old = await this.store.readConfig(session);
        requireStore(old, 'CONFIG_UNAVAILABLE');
        this.guard();
        value = configDto(
          await this.store.writeConfig(
            session,
            { schema: old.schema, expectedRevision: input.expectedRevision, value: input.value },
            operation.signal,
          ),
        );
      } else throw Error('METHOD_NOT_ALLOWED');
      await this.store.assertSession(session, session.fence);
      this.guard();
      operation.signal.throwIfAborted();
      result = { ok: true, value };
    } catch {
      if (createdSubscription !== undefined) this.subscriptions.delete(createdSubscription);
      result = { ok: false, code: 'REQUEST_DENIED' };
    } finally {
      clearTimeout(timeout);
      this.pending.delete(data.id);
    }
    requireStore(isUiJson(result, 65536), 'OUTPUT_LIMIT');
    this.send({ kind: 'reply', id: data.id, result });
  }
  close(normal = true): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.stopped = true;
    this.subscriptions.clear();
    for (const operation of this.pending.values()) operation.abort();
    this.detach();
    clearTimeout(this.timer);
    clearInterval(this.poll);
    if (this.hello) this.win.removeEventListener('message', this.hello);
    let finish: (() => Promise<void>) | undefined;
    if (this.session) {
      try {
        finish = this.store.retireSession(this.session);
      } catch {
        this.store.closeSession(this.session);
      }
    }
    this.port?.close();
    this.frame?.remove();
    if (this.session) this.owners.remove(this.session.fence.instanceId);
    this.reject(Error('VIEW_CLOSED'));
    this.cleanup = (async () => {
      try {
        await this.preparation?.catch(() => {});
        if (normal) await finish?.();
      } finally {
        try {
          await this.closeLease?.();
        } finally {
          this.release();
        }
      }
    })();
    void this.cleanup.catch(() => {});
    return this.cleanup;
  }
}
