import { useMemo } from 'react';
import { TitleTranslationStore } from './title-translation-store';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { serverManagementApi } from '../server-management/use-server-management-client';
import { useSelfHostCapability } from '../auth/self-host-account-api';
import type {
  TitleTranslationResponse,
  TranslationConfiguration,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
  TranslationSettings,
} from '../../translation/contracts';
import { translationMessage } from '../../translation/contracts';
export class TranslationClient {
  readonly titles = new TitleTranslationStore({
    configuration: (signal) => this.configuration(signal),
    translate: (titles, signal) =>
      this.api.request<TitleTranslationResponse>('/translation/titles', {
        method: 'POST',
        body: JSON.stringify({ titles }),
        signal,
      }),
  });
  constructor(private readonly api: Pick<RemoteApiClient, 'request'>) {}
  configuration(signal?: AbortSignal) {
    return this.api.request<TranslationConfiguration>('/translation/settings', { signal });
  }
  async save(settings: TranslationSettings, revision: number) {
    const result = await this.api.request<TranslationConfiguration>('/translation/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings, revision }),
    });
    this.titles.configure(result);
    return result;
  }
  async credential(provider: TranslationProvider, value: string) {
    const result = await this.api.request(`/translation/credentials/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    this.titles.invalidate();
    return result;
  }
  async deleteCredential(provider: TranslationProvider) {
    const result = await this.api.request(`/translation/credentials/${provider}`, { method: 'DELETE' });
    this.titles.invalidate();
    return result;
  }
  request(input: TranslationRequest, signal?: AbortSignal) {
    return this.api.request<{ result: TranslationResult | null }>('/translation/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  }
  result(id: string, signal?: AbortSignal) {
    return this.api.request<TranslationResult>(`/translation/jobs/${encodeURIComponent(id)}`, { signal });
  }
  cancel(id: string) {
    return this.api.request(`/translation/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async clear() {
    const result = await this.api.request('/translation/cache', { method: 'DELETE' });
    this.titles.invalidate();
    return result;
  }
}
const clients = new WeakMap<RemoteApiClient, { scope: string; client: TranslationClient }>();
function sharedClient(api: RemoteApiClient, scope: string) {
  const existing = clients.get(api);
  if (existing?.scope === scope) return existing.client;
  existing?.client.titles.dispose();
  const client = new TranslationClient(api);
  clients.set(api, { scope, client });
  return client;
}
export function useTranslationClient() {
  const api = serverManagementApi(useOptionalAppRuntime());
  const permitted = useSelfHostCapability('useProviders');
  const scope = api?.coverCacheScope;
  return useMemo(() => (api && permitted ? sharedClient(api, scope!) : undefined), [api, permitted, scope]);
}
export function translationError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/translation_[a-z_]+/);
  return translationMessage(match?.[0]);
}
