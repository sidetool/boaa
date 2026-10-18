import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import type { TTSSynthesisProvider } from '../../../../src/providers/tts';
import type { ServerConfig } from '../config.js';
import { listServerProviderCatalog } from './server-provider-catalog.js';
import {
  loadProviderSettingsBundle,
  providerEnabledBySettings,
  providerOptionsFromSettings,
  modelFromSettings,
} from './server-provider-settings.js';
import { providerSecretStatusBundle, resolveProviderSecrets } from './server-provider-secrets.js';
import {
  createServerTTSSynthesisProvider,
  isServerTTSProviderId,
  modelIdForTTSProvider,
} from './server-tts-provider-factory.js';

export interface PlainTTSSource {
  id: string;
  name: string;
  modelId?: string;
  revision: string;
  paid: boolean;
  legacyIds?: boolean;
  providerOptions?: Record<string, unknown>;
  createProvider(): Promise<TTSSynthesisProvider>;
}

/** Reuse administrator-owned provider settings and secrets; never accept an endpoint or key from playback. */
export async function loadPlainTTSSources(
  pool: pg.Pool,
  config: ServerConfig,
  env: NodeJS.ProcessEnv,
): Promise<PlainTTSSource[]> {
  const settings = (await loadProviderSettingsBundle(pool, config, env)).ttsSynthesis;
  const { catalog, secretStatuses } = await providerSecretStatusBundle(
    pool,
    config,
    listServerProviderCatalog(env),
    env,
  );
  const sources: PlainTTSSource[] = [];
  for (const entry of catalog.ttsProviders) {
    const id = entry.providerId;
    if (!isServerTTSProviderId(id) || id === 'system' || !entry.implemented || !providerEnabledBySettings(settings, id))
      continue;
    // Unconfigured providers are offered in connection settings, not as broken playback engines.
    if (!entry.secretConfigured) continue;
    const modelId = modelIdForTTSProvider(id, modelFromSettings(settings, id), env);
    const providerOptions = { ...providerOptionsFromSettings(settings, id) };
    if (id === 'local-endpoint' && !providerOptions.voice && env.TTS_LOCAL_ENDPOINT_VOICE_ID?.trim()) {
      providerOptions.voice = env.TTS_LOCAL_ENDPOINT_VOICE_ID.trim();
    }
    sources.push({
      id,
      name: id === 'local-endpoint' && modelId === 'supertonic-3-ko' ? 'Supertonic 3' : entry.displayName,
      modelId,
      paid: id !== 'local-endpoint',
      providerOptions,
      revision: structuredIntegrityHash({
        id,
        modelId,
        providerOptions,
        updatedAt: settings.updatedAt,
        secretUpdatedAt: secretStatuses
          .filter((secret) => secret.scope === 'tts_synthesis' && secret.providerId === id)
          .map(({ secretName, configured, updatedAt }) => ({ secretName, configured, updatedAt })),
      }),
      createProvider: async () =>
        createServerTTSSynthesisProvider({
          providerId: id,
          modelId,
          env,
          providerOptions,
          secrets: await resolveProviderSecrets(pool, config, 'tts_synthesis', id, env),
        }),
    });
  }
  return sources.sort(
    (a, b) => Number(b.id === settings.defaultProviderId) - Number(a.id === settings.defaultProviderId),
  );
}
