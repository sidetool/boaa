import { pluginImageRequest } from '../../../packages/extension-contracts/plugin-images';
import { uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
import { pluginHttpRequest, type PluginHttpOwner } from '../../../packages/extension-contracts/plugin-http';
import type { Installation, PluginSession } from './store-model';
import type { PlatformPluginStore } from './plugin-store';
import { requireStore } from '../ui/store-model';
import { PluginHttpRequestQueue } from './http-request-queue';
export interface PluginConnectionStatus {
  slot: string;
  endpoint: string;
  roles: string[];
  methods: string[];
  headers: string[];
  revision: string;
  authenticated: boolean;
}
/** Host-only client. No guest can choose owner, role, revision, auth headers or absolute URL. */
export class PluginHttp {
  private requests = new PluginHttpRequestQueue();
  private pending = new WeakMap<PluginSession, Map<number, AbortController>>();
  async controller(session: PluginSession, method: string, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    await this.store.assertCall(session, session.fence, method);
    requireStore(uiRecord(input) && uiInteger(input.id, 1, Number.MAX_SAFE_INTEGER), 'HTTP_INVALID_REQUEST');
    let calls = this.pending.get(session);
    if (!calls) {
      calls = new Map();
      this.pending.set(session, calls);
    }
    if (method === 'http.cancel') {
      requireStore(uiKeys(input, ['id']), 'HTTP_INVALID_REQUEST');
      calls.get(input.id)?.abort();
      return null;
    }
    requireStore(uiKeys(input, ['id', 'request']) && calls.size < 4 && !calls.has(input.id), 'HTTP_REQUEST_LIMIT');
    const abort = new AbortController();
    calls.set(input.id, abort);
    try {
      return await this.request(session, input.request, AbortSignal.any([signal, abort.signal]));
    } finally {
      calls.delete(input.id);
    }
  }
  constructor(
    private store: PlatformPluginStore,
    private profileId: string,
    private lifetime: AbortSignal,
    private transport: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}
  owner(row: Pick<Installation, 'installationId' | 'active' | 'revision'>): PluginHttpOwner {
    return {
      profileId: this.profileId,
      installationId: row.installationId,
      digest: row.active!,
      generation: row.revision,
    };
  }
  async host(
    action: string,
    owner: PluginHttpOwner,
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime]) : this.lifetime;
    const send = async () => {
      combined.throwIfAborted();
      const response = await this.transport(`/api/plugins/connections/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-boaa-plugin-host': '1' },
        body: JSON.stringify({ owner, ...data }),
        signal: combined,
      });
      if (!response.ok) throw Error('PLUGIN_CONNECTION_DENIED');
      return response.json();
    };
    return ['cover', 'image', 'request'].includes(action)
      ? this.requests.run(JSON.stringify([owner.profileId, owner.installationId]), combined, send)
      : send();
  }
  async list(row: Pick<Installation, 'installationId' | 'active' | 'revision'>): Promise<PluginConnectionStatus[]> {
    return (await this.host('list', this.owner(row))) as PluginConnectionStatus[];
  }
  async revoke(row: Installation, slot?: string) {
    await this.host('revoke', this.owner(row), slot ? { slot } : {});
  }
  /** Retire only the reviewed generation; a concurrent update may already have new connections. */
  async retire(row: Installation) {
    await this.host('retire', this.owner(row));
  }
  async image(session: PluginSession, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    await this.store.assertCall(session, session.fence, 'http.image');
    requireStore(pluginImageRequest(input), 'IMAGE_INVALID_REQUEST');
    const row = (await this.store.list()).find((r) => r.installationId === session.fence.installationId);
    requireStore(
      row?.active === session.fence.digest && row.manifest?.contributes.connections?.includes(input.slot),
      'HTTP_CONNECTION_DENIED',
    );
    const owner = this.owner(row),
      requestId = crypto.randomUUID(),
      abort = new AbortController();
    const combined = AbortSignal.any([signal, this.lifetime, abort.signal]);
    let dispatched = false,
      checking = false;
    const poll = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.store
        .assertCall(session, session.fence, 'http.image')
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 200);
    const cancel = () => {
      if (dispatched)
        void this.transport('/api/plugins/connections/cancel', {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'content-type': 'application/json', 'x-boaa-plugin-host': '1' },
          body: JSON.stringify({ owner, requestId }),
        }).catch(() => {});
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      combined.throwIfAborted();
      const connections = (await this.host('list', owner, {}, combined)) as PluginConnectionStatus[];
      const connection = connections.find(
        (c) => c.slot === input.slot && c.roles.includes('ui') && c.methods.includes('GET'),
      );
      requireStore(connection, 'HTTP_CONNECTION_REQUIRED');
      await this.store.assertCall(session, session.fence, 'http.image');
      combined.throwIfAborted();
      dispatched = true;
      const result = await this.host(
        'image',
        owner,
        { requestId, revision: connection.revision, request: input },
        combined,
      );
      await this.store.assertCall(session, session.fence, 'http.image');
      combined.throwIfAborted();
      return result as UiJson;
    } finally {
      clearInterval(poll);
      combined.removeEventListener('abort', cancel);
    }
  }
  async request(session: PluginSession, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    await this.store.assertCall(session, session.fence, 'http.request');
    requireStore(pluginHttpRequest(input), 'HTTP_INVALID_REQUEST');
    const row = (await this.store.list()).find((r) => r.installationId === session.fence.installationId);
    requireStore(
      row?.active === session.fence.digest && row.manifest?.contributes.connections?.includes(input.slot),
      'HTTP_CONNECTION_DENIED',
    );
    const owner = this.owner(row),
      requestId = crypto.randomUUID();
    const abort = new AbortController(),
      combined = AbortSignal.any([signal, this.lifetime, abort.signal]);
    let dispatched = false,
      checking = false;
    const poll = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.store
        .assertCall(session, session.fence, 'http.request')
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 200);
    const cancel = () => {
      if (!dispatched) return;
      // Independent best-effort cancellation complements disconnect detection and server deadline.
      void this.transport('/api/plugins/connections/cancel', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-boaa-plugin-host': '1' },
        body: JSON.stringify({ owner, requestId }),
      }).catch(() => {});
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      const connections = (await this.host('list', owner, {}, combined)) as PluginConnectionStatus[];
      const connection = connections.find((c) => c.slot === input.slot && c.roles.includes(session.role));
      requireStore(connection, 'HTTP_CONNECTION_REQUIRED');
      await this.store.assertCall(session, session.fence, 'http.request');
      combined.throwIfAborted();
      dispatched = true;
      const result = await this.host(
        'request',
        owner,
        { requestId, role: session.role, revision: connection.revision, request: input },
        combined,
      );
      await this.store.assertCall(session, session.fence, 'http.request');
      combined.throwIfAborted();
      return result as UiJson;
    } catch {
      return {
        ok: false,
        code: combined.aborted ? 'HTTP_CANCELLED' : 'HTTP_FAILED',
        outcome: dispatched && !['GET', 'HEAD', 'OPTIONS'].includes(input.method) ? 'unknown' : 'not-sent',
      };
    } finally {
      clearInterval(poll);
      combined.removeEventListener('abort', cancel);
    }
  }
}
