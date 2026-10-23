import { PluginHttp } from './plugin-http';
import { ReaderBindings, type ReaderBinding } from './reader-binding';
import { ServerPluginDatabase } from './server-plugin-database';
import { scopeKey } from '../ui/store-model';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { uiRecord } from '@boaa/extension-contracts/ui-json';
import { requireEnvironment } from '../ui/runtime-policy';
import { PlatformPluginStore } from './plugin-store';
import { PluginService } from './plugin-service';
import { PluginViewRuntime } from './view-runtime';
import { migrateLegacyPlatformPlugins } from './legacy-platform-migration';

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
export async function loadPluginDeployment(
  apiBase: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<PluginDeployment> {
  const base = new URL(apiBase.replace(/\/$/, '') + '/', location.href);
  if (base.origin !== location.origin) throw Error('PLUGIN_SAME_ORIGIN_REQUIRED');
  const response = await transport(new URL('plugins/context', base), {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok)
    throw Error(
      response.status === 404
        ? 'PLUGIN_DEPLOYMENT_DISABLED'
        : [401, 403].includes(response.status)
          ? 'PLUGIN_ACCOUNT_UNAVAILABLE'
          : 'PLUGIN_SERVER_UNAVAILABLE',
    );
  return validatePluginDeployment(await response.json(), location.origin);
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
  readonly database: ServerPluginDatabase;
  private unwatch: () => void;
  private unbind: () => void;
  private restoringBinding = false;
  private bindingRevision = 0;
  persistenceError = '';
  migrationNotice = '';
  private preparation?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    readonly deployment: PluginDeployment,
    private readonly win: Window,
    transport: typeof fetch = fetch,
  ) {
    requireEnvironment(win, 'self-host', true);
    this.off = new URL(win.location.href).searchParams.getAll('plugins').includes('off');
    const scope = {
      kind: 'remote',
      profileId: deployment.accountId,
      serverId: deployment.serverId,
      accountId: deployment.accountId,
      libraryId: deployment.libraryId,
    } as const;
    this.database = new ServerPluginDatabase({ scope: scopeKey(scope), transport, signal: this.signal });
    this.store = new PlatformPluginStore(scope, { database: this.database });
    this.workerOptions = { worker: () => new Worker(deployment.worker, { type: 'module' }), wasmUrl: deployment.wasm };
    this.bindings = new ReaderBindings();
    this.http = new PluginHttp(this.store, deployment.accountId, this.signal, transport);
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
    this.unbind = this.bindings.subscribe(() => {
      if (this.restoringBinding) return;
      this.bindingRevision++;
      void this.database
        .writePreference('reader-input', (this.bindings.get() ?? null) as unknown as UiJson)
        .then(() => {
          this.persistenceError = '';
        })
        .catch(() => {
          this.persistenceError = '입력 설정을 서버에 저장하지 못했어요. 연결 후 다시 선택해 주세요.';
        });
    });
    this.unwatch = this.database.subscribe(() => {
      void this.refreshBinding()
        .then(() => this.service.reconcile())
        .catch(() => {});
    });
  }
  prepare(): Promise<void> {
    return (this.preparation ??= this.migrateLegacy());
  }
  private async migrateLegacy() {
    try {
      const result = await migrateLegacyPlatformPlugins({
        database: this.database,
        newScope: {
          kind: 'remote',
          profileId: this.deployment.accountId,
          serverId: this.deployment.serverId,
          accountId: this.deployment.accountId,
          libraryId: this.deployment.libraryId,
        },
        storage: { getItem: (key) => this.win.localStorage.getItem(key) },
        factory: this.win.indexedDB,
        signal: this.signal,
      });
      if (result.failed || result.rollbackRetainedLocally)
        this.migrationNotice =
          '이전 브라우저의 일부 플러그인 자료를 옮기지 못했습니다. 원본은 보관되어 있으니 필요한 플러그인을 다시 설치해 주세요.';
      else if (result.imported)
        this.migrationNotice =
          '이전 브라우저의 플러그인을 서버로 옮겼습니다. 외부 연결이 필요한 플러그인은 연결 설정을 확인해 주세요.';
    } catch {
      if (!this.signal.aborted)
        this.migrationNotice =
          '이전 브라우저 설치본을 옮기지 못했습니다. 다시 확인하거나 플러그인 파일을 설치해 주세요.';
    }
  }
  async refreshBinding() {
    const revision = this.bindingRevision;
    const value = await this.database.readPreference('reader-input');
    if (this.signal.aborted || revision !== this.bindingRevision) return;
    this.restoringBinding = true;
    try {
      this.bindings.restore(value ? (value as unknown as ReaderBinding) : undefined);
    } finally {
      this.restoringBinding = false;
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort();
      this.unwatch();
      this.unbind();
      this.bindings.close();
      // Both synchronously revoke their effects before awaiting persistent cleanup.
      const cleanup = [this.views.close(), this.service.close()];
      this.store.suspend();
      this.closing = Promise.allSettled(cleanup).then(() => this.store.close());
    }
    return this.closing;
  }
}
