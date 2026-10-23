import {
  pluginCacheRequest,
  type PluginCacheRequest,
  type PluginCacheResult,
} from '../../../packages/extension-contracts/plugin-cache';
import type { PluginHttpOwner } from '../../../packages/extension-contracts/plugin-http';
import type { PlatformPluginStore } from './plugin-store';
import type { PluginSession } from './store-model';
import { requireStore } from '../ui/store-model';
import type { UiJson } from '@boaa/extension-contracts/ui-json';

/** Uses the account server, never localStorage/IndexedDB. Caches are optional for correctness. */
export class PluginCacheClient {
  constructor(
    private store: PlatformPluginStore,
    private profileId: string,
    private lifetime: AbortSignal,
    private transport: typeof fetch,
  ) {}
  async host(
    owner: PluginHttpOwner,
    kind: 'home' | 'data',
    role: 'controller' | 'ui',
    request: PluginCacheRequest,
    signal?: AbortSignal,
  ): Promise<PluginCacheResult> {
    requireStore(pluginCacheRequest(request), 'INVALID_ARGUMENT');
    const response = await this.transport('/api/plugins/cache', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-boaa-plugin-host': '1' },
      body: JSON.stringify({ owner, kind, role, request }),
      signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(4000), ...(signal ? [signal] : [])]),
    });
    requireStore(response.ok, 'CACHE_UNAVAILABLE');
    return response.json();
  }
  async call(session: PluginSession, method: string, input: UiJson, signal: AbortSignal): Promise<UiJson> {
    await this.store.assertCall(session, session.fence, method);
    const request = { ...(input as object), action: method.slice(6) };
    requireStore(pluginCacheRequest(request), 'INVALID_ARGUMENT');
    const row = (await this.store.list()).find((r) => r.installationId === session.fence.installationId);
    requireStore(row && (session.role === 'ui' || session.role === 'controller'), 'CACHE_DENIED');
    const result = await this.host(
      { profileId: this.profileId, installationId: row.installationId, digest: row.active!, generation: row.revision },
      'data',
      session.role,
      request,
      signal,
    );
    await this.store.assertCall(session, session.fence, method);
    signal.throwIfAborted();
    return result as unknown as UiJson;
  }
}
