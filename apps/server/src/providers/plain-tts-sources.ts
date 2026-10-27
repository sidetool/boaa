import type pg from 'pg';
import { structuredIntegrityHash } from '@boaa/text-core/hash';
import { TTSConnectionStore } from './tts-connections.js';
import type { TTSSynthesisProvider } from '../../../../src/providers/tts';
import type { AudiobookInput } from '../../../../src/providers/plain-audiobook';
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
  synthesisRevision?: string;
  paid: boolean;
  /** Background preparation only. Unknown/custom servers remain serial. Not part of audio identity. */
  backgroundConcurrency?: 1 | 2;
  /** Only an explicitly configured default may supply the unspecified server voice. */
  default?: boolean;
  legacyIds?: boolean;
  providerOptions?: Record<string, unknown>;
  createProvider(): Promise<TTSSynthesisProvider>;
}

export function preparedTTSConcurrency(settings: AudiobookInput, sources: readonly PlainTTSSource[]): 1 | 2 {
  const models = settings.cast ? Object.values(settings.cast.models) : settings.model ? [settings.model] : [];
  // Mixed pools obey the least capable server. Payment and protocol do not establish GPU capacity.
  return models.length &&
    models.every((model) => sources.find((s) => s.id === model.providerId)?.backgroundConcurrency === 2)
    ? 2
    : 1;
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
    const synthesisOptions = { ...providerOptions };
    // These options are overridden by ordinary listening's request, not the selected synthesis model.
    for (const key of ['voice', 'responseFormat', 'outputFormat', 'audioEncoding', 'format', 'speed', 'speakingRate'])
      delete synthesisOptions[key];
    sources.push({
      id,
      name: id === 'local-endpoint' && modelId === 'supertonic-3-ko' ? 'Supertonic 3' : entry.displayName,
      modelId,
      paid: id !== 'local-endpoint',
      backgroundConcurrency: id === 'local-endpoint' ? 1 : 2,
      default: id === settings.defaultProviderId,
      providerOptions,
      synthesisRevision: structuredIntegrityHash({ id, modelId, providerOptions: synthesisOptions }),
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
  sources.push(...(await new TTSConnectionStore(pool, config, env).sources()));
  return sources.sort(
    (a, b) => Number(b.id === settings.defaultProviderId) - Number(a.id === settings.defaultProviderId),
  );
}
