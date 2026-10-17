import { readBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { PluginHttp } from './plugin-http';
import { ReaderBindings } from './reader-binding';
import { retirementJournal } from './retirement-journal';
import { uiRecord } from '@boaa/extension-contracts/ui-json';
import { requireEnvironment } from '../ui/runtime-policy';
import { PlatformPluginStore } from './plugin-store';
import { PluginService } from './plugin-service';
import { PluginViewRuntime } from './view-runtime';

export interface PluginDeployment {
  version: 1;
  origin: string;
  serverId: string;
  accountId: string;
  libraryId: string;
  worker: string;
  wasm: string;
  shell: string;
}
export function validatePluginDeployment(value: unknown, origin: string): PluginDeployment {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !uiRecord(value) ||
    value.version !== 1 ||
    value.origin !== origin ||
    !['serverId', 'accountId', 'libraryId'].every((k) => typeof value[k] === 'string' && uuid.test(value[k])) ||
    value.worker !== '/plugin-runtime/controller-worker.js' ||
    value.wasm !== '/plugin-runtime/quickjs.wasm' ||
    value.shell !== '/plugin-runtime/shell'
  )
    throw Error('PLUGIN_DEPLOYMENT_MISMATCH');
  return value as unknown as PluginDeployment;
}
export async function loadPluginDeployment(apiBase: string, signal: AbortSignal): Promise<PluginDeployment> {
  const base = new URL(apiBase.replace(/\/$/, '') + '/', location.href);
  if (base.origin !== location.origin) throw Error('PLUGIN_SAME_ORIGIN_REQUIRED');
  const response = await fetch(new URL('plugins/context', base), {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw Error(response.status === 404 ? 'PLUGIN_DEPLOYMENT_DISABLED' : 'PLUGIN_ACCOUNT_UNAVAILABLE');
  return validatePluginDeployment(await response.json(), location.origin);
}
export function pluginProfileId(storage: Storage): string {
  const key = 'boaa.plugin-profile.v1';
  let id = readBrandStorage(storage, key);
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    writeBrandStorage(storage, key, id);
  }
  return id;
}
export class ProductPluginSession {
  readonly instanceId = crypto.randomUUID();
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  readonly store: PlatformPluginStore;
  readonly service: PluginService;
  readonly http: PluginHttp;
  readonly bindings: ReaderBindings;
  readonly views: PluginViewRuntime;
  readonly workerOptions: { worker: () => Worker; wasmUrl: string };
  readonly off: boolean;
  private closing?: Promise<void>;
  constructor(
    readonly deployment: PluginDeployment,
    win: Window,
  ) {
    requireEnvironment(win, 'self-host', true);
    this.off = new URL(win.location.href).searchParams.getAll('plugins').includes('off');
    this.store = new PlatformPluginStore(
      {
        kind: 'remote',
        profileId: pluginProfileId(win.localStorage),
        serverId: deployment.serverId,
        accountId: deployment.accountId,
        libraryId: deployment.libraryId,
      },
      { retirements: retirementJournal(win.localStorage) },
    );
    this.workerOptions = { worker: () => new Worker(deployment.worker, { type: 'module' }), wasmUrl: deployment.wasm };
    this.bindings = new ReaderBindings({
      storage: win.localStorage,
      window: win,
      key:
        'boaa.plugin-reader-input.v1:' +
        JSON.stringify([
          pluginProfileId(win.localStorage),
          deployment.serverId,
          deployment.accountId,
          deployment.libraryId,
        ]),
    });
    this.http = new PluginHttp(this.store, pluginProfileId(win.localStorage), this.signal);
    this.service = new PluginService(this.store, {
      ...this.workerOptions,
      off: this.off,
      bindings: this.bindings,
      http: this.http,
    });
    this.views = new PluginViewRuntime(this.store, this.service, {
      window: win,
      shellUrl: deployment.shell,
      http: this.http,
      deployment: 'self-host',
      off: this.off,
    });
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort();
      this.bindings.close();
      // Both synchronously revoke their effects before awaiting persistent cleanup.
      const cleanup = [this.views.close(), this.service.close()];
      this.store.suspend();
      this.closing = Promise.allSettled(cleanup).then(() => this.store.close());
    }
    return this.closing;
  }
}
