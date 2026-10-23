import { PluginImages } from './images';
import { PLUGIN_IMAGE_REPLY_BYTES } from '../../../../packages/extension-contracts/plugin-images';
import { SettingsSubscriptions } from './settings-subscriptions';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { isUiJson, uiRecord, uiKeys, uiInteger, uiUtf8Size, type UiJson } from '@boaa/extension-contracts/ui-json';
import { canonicalJson } from '../../ui/store-model';
import { platformStorageError } from '../../../../packages/extension-contracts/plugin-platform-sdk';
declare const __BOAA_UI_PARENT_ORIGIN__: string;
const hostOrigin = __BOAA_UI_PARENT_ORIGIN__;
if (parent !== window) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let bound = false;
  const timeout = setTimeout(() => removeEventListener('message', bind), 5000);
  function bind(event: MessageEvent) {
    if (
      bound ||
      event.source !== parent ||
      event.origin !== hostOrigin ||
      !isUiJson(event.data, 4096) ||
      !uiRecord(event.data) ||
      !uiKeys(event.data, ['kind', 'nonce', 'fence']) ||
      event.data.kind !== 'bind' ||
      event.data.nonce !== nonce ||
      !uiRecord(event.data.fence) ||
      event.ports.length !== 1
    )
      return;
    bound = true;
    clearTimeout(timeout);
    removeEventListener('message', bind);
    const fence = event.data.fence,
      key = canonicalJson(fence),
      port = event.ports[0],
      send = port.postMessage.bind(port);
    let sequence = 0,
      loaded = false,
      stopped = false,
      plugin: { apiVersion: number; activate: (ctx: unknown) => unknown } | undefined,
      url: string | undefined;
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (v: UiJson) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        detach: () => void;
      }
    >();
    const revoke = () => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    const fail = () => {
      if (stopped) return;
      stopped = true;
      revoke();
      images?.close();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.detach();
        p.reject(Error('VIEW_CLOSED'));
      }
      pending.clear();
      subscriptions.close();
      send({ kind: 'failed', fence });
      port.close();
    };
    const request = (method: string, input: UiJson, signal?: AbortSignal): Promise<UiJson> => {
      if (signal?.aborted) return Promise.reject(Error('CANCELLED'));
      if (stopped || pending.size >= 4 || !isUiJson(input, 65536)) return Promise.reject(Error('REQUEST_LIMIT'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const cancel = (code: string) => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          clearTimeout(p.timer);
          p.detach();
          send({ kind: 'cancel', fence, id });
          reject(Error(code));
        };
        const abort = () => cancel(method === 'http.request' ? 'HTTP_OUTCOME_UNKNOWN' : 'CANCELLED');
        pending.set(id, {
          method,
          resolve,
          reject,
          detach: () => signal?.removeEventListener('abort', abort),
          timer: setTimeout(
            () => cancel(method === 'http.request' ? 'HTTP_OUTCOME_UNKNOWN' : 'TIMEOUT'),
            ['http.request', 'http.image', 'controller.call'].includes(method) ? 25000 : 5000,
          ),
        });
        signal?.addEventListener('abort', abort, { once: true });
        send({ kind: 'call', fence, id, method, input });
      });
    };
    const subscriptions = new SettingsSubscriptions(request, fail);
    const images = new PluginImages(request, () => pending.size < 3);
    addEventListener('pagehide', () => images?.close());
    addEventListener('error', fail);
    addEventListener('unhandledrejection', fail);
    port.onmessageerror = fail;
    port.onmessage = ({ data }) => {
      if (stopped) return;
      if (
        !isUiJson(data, 2 * BOAA_PACKAGE_LIMITS.entryBytes + 8192) ||
        !uiRecord(data) ||
        canonicalJson(data.fence as UiJson) !== key
      ) {
        fail();
        return;
      }
      if (data.kind === 'settings.changed') {
        try {
          if (
            !uiKeys(data, ['kind', 'fence', 'subscription', 'value']) ||
            !uiInteger(data.subscription, 1, Number.MAX_SAFE_INTEGER)
          )
            throw Error('INVALID_MESSAGE');
          subscriptions.receive(data.subscription, data.value);
        } catch {
          fail();
        }
        return;
      }
      if (data.kind === 'reply') {
        if (
          !uiInteger(data.id, 1, Number.MAX_SAFE_INTEGER) ||
          !uiRecord(data.result) ||
          typeof data.result.ok !== 'boolean'
        ) {
          fail();
          return;
        }
        const p = pending.get(data.id);
        if (!p) return;
        if (!isUiJson(data.result, p.method === 'http.image' ? PLUGIN_IMAGE_REPLY_BYTES : 65536)) {
          fail();
          return;
        }
        pending.delete(data.id);
        clearTimeout(p.timer);
        p.detach();
        if (data.result.ok && uiKeys(data.result, ['ok', 'value'])) p.resolve(data.result.value);
        else
          p.reject(
            Error(
              !data.result.ok && uiKeys(data.result, ['ok', 'code']) && platformStorageError(data.result.code)
                ? data.result.code
                : 'REQUEST_DENIED',
            ),
          );
        return;
      }
      if (
        loaded ||
        data.kind !== 'code' ||
        typeof data.source !== 'string' ||
        uiUtf8Size(data.source) > BOAA_PACKAGE_LIMITS.entryBytes ||
        typeof data.view !== 'string'
      ) {
        fail();
        return;
      }
      loaded = true;
      const root = document.getElementById('boaa-plugin-root');
      const ctx = Object.freeze({
        images: Object.freeze({ load: images.load.bind(images) }),
        app: Object.freeze({
          search: async (query: string): Promise<void> => {
            if (!navigator.userActivation?.isActive) throw Error('USER_ACTION_REQUIRED');
            await request('app.search', { query });
          },
        }),
        http: Object.freeze({
          request: async (input: UiJson, signal?: AbortSignal): Promise<UiJson> => {
            if (signal?.aborted) return { ok: false, code: 'HTTP_CANCELLED', outcome: 'not-sent' };
            try {
              return await request('http.request', input, signal);
            } catch {
              return { ok: false, code: signal?.aborted ? 'HTTP_CANCELLED' : 'HTTP_FAILED', outcome: 'unknown' };
            }
          },
        }),
        controller: Object.freeze({
          call: (handler: string, value: UiJson = null, options?: { signal?: AbortSignal }) =>
            request('controller.call', { handler, value }, options?.signal),
        }),
        view: Object.freeze({ id: data.view, root }),
        storage: Object.freeze({
          get: (key: string) => request('storage.get', { key }),
          set: (key: string, value: UiJson, expectedRevision: number | null = null) =>
            request('storage.set', { key, value, expectedRevision }),
          remove: (key: string, expectedRevision: number) => request('storage.remove', { key, expectedRevision }),
          list: (options: { prefix?: string; cursor?: string; limit?: number } = {}) =>
            request('storage.list', { limit: 32, ...options }),
        }),
        settings: Object.freeze({
          subscribe: subscriptions.subscribe.bind(subscriptions),
          get: () => request('settings.get', {}),
          set: (expectedRevision: number, value: UiJson) => request('settings.set', { expectedRevision, value }),
          register: (schema: UiJson) => request('settings.register', { schema }),
        }),
      });
      Object.defineProperty(globalThis, 'BoaaPlugin', {
        value: Object.freeze({
          register(value: typeof plugin) {
            if (plugin || !value || value.apiVersion !== 2 || typeof value.activate !== 'function')
              throw Error('INVALID_REGISTRATION');
            plugin = value;
          },
        }),
        writable: false,
        configurable: false,
      });
      Object.defineProperty(globalThis, 'MoyaPlugin', Object.getOwnPropertyDescriptor(globalThis, 'BoaaPlugin')!);
      url = URL.createObjectURL(new Blob([data.source], { type: 'text/javascript' }));
      const script = document.createElement('script');
      script.src = url;
      script.onerror = fail;
      script.onload = () => {
        revoke();
        void Promise.resolve()
          .then(() => {
            if (!plugin) throw Error('NOT_REGISTERED');
            return plugin.activate(ctx);
          })
          .then(() => {
            if (!stopped) send({ kind: 'ready', fence });
          })
          .catch(fail);
      };
      document.body.append(script);
    };
    port.start();
    send({ kind: 'bound', fence });
  }
  addEventListener('message', bind);
  parent.postMessage({ kind: 'hello', nonce }, hostOrigin);
}
