import type {
  SourceNetworkSettings,
  SourceNetworkSettingsRequest,
  SourceNetworkDefaultMode,
} from '../../../../packages/extension-contracts/source-network-settings.js';
import type { SourceCredentialVault } from './source-credential-vault.js';
import { parseOutboundProxy, type SourceProxyOptions } from './outbound-proxy.js';
import type { ByeDpiProcess } from './byedpi-process.js';

const scope = JSON.stringify(['host:source-network', 'source-network', 'v1']);

/** Same owner vault as installed sources. Reads on use so changes need no server restart. */
export function createSourceNetworkSettings(
  vault?: SourceCredentialVault,
  environment = process.env.SOURCE_OUTBOUND_PROXY,
  byedpi?: ByeDpiProcess,
) {
  const savedSettings = () => {
    const secret = vault?.read(scope)?.secret;
    return secret
      ? (JSON.parse(secret) as {
          revision: number;
          defaultProxy: string | null;
          defaultMode?: SourceNetworkDefaultMode;
          byedpiEnabled?: boolean;
        })
      : undefined;
  };
  const read = (): SourceNetworkSettings => {
    const saved = savedSettings();
    const inherited = !saved || saved.defaultProxy === null;
    const defaultProxy = parseOutboundProxy(inherited ? environment : saved.defaultProxy) ?? '';
    const defaultMode = saved?.defaultMode ?? (saved?.byedpiEnabled ? 'byedpi' : defaultProxy ? 'custom' : 'direct');
    return {
      revision: saved?.revision ?? 0,
      defaultProxy,
      defaultMode,
      origin: inherited ? (defaultProxy ? 'environment' : 'direct') : 'settings',
      effectiveProxy: defaultMode === 'byedpi' ? byedpi?.proxyUrl : defaultMode === 'direct' ? '' : defaultProxy,
      byedpi: { ...(byedpi?.status() ?? { available: false, running: false }), enabled: defaultMode === 'byedpi' },
    };
  };
  const validate = (input: SourceNetworkSettingsRequest) => {
    if (!vault) throw new Error('source_network_unavailable');
    if (
      !input ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      (typeof input.defaultProxy !== 'string' && input.defaultProxy !== null) ||
      (input.byedpiEnabled !== undefined && typeof input.byedpiEnabled !== 'boolean') ||
      (input.defaultMode !== undefined && !['direct', 'byedpi', 'custom'].includes(input.defaultMode)) ||
      (input.defaultMode !== undefined &&
        input.byedpiEnabled !== undefined &&
        input.byedpiEnabled !== (input.defaultMode === 'byedpi'))
    )
      throw new Error('compatibility_preferences_invalid');
    const defaultProxy = input.defaultProxy === null ? null : (parseOutboundProxy(input.defaultProxy) ?? '');
    if (read().revision !== input.revision) throw new Error('source_network_conflict');
    return defaultProxy;
  };
  const selection = (input: SourceNetworkSettingsRequest, defaultProxy: string | null): SourceNetworkDefaultMode => {
    const proxy = parseOutboundProxy(defaultProxy === null ? environment : defaultProxy);
    const enabled = input.byedpiEnabled ?? read().byedpi?.enabled ?? false;
    const mode = input.defaultMode ?? (enabled ? 'byedpi' : proxy ? 'custom' : 'direct');
    if (mode === 'custom' && !proxy) throw new Error('compatibility_preferences_invalid');
    return mode;
  };
  const persist = (
    input: SourceNetworkSettingsRequest,
    defaultProxy: string | null,
    defaultMode: SourceNetworkDefaultMode,
  ) => {
    if (read().revision !== input.revision) throw new Error('source_network_conflict');
    vault!.write(scope, {
      secret: JSON.stringify({
        revision: input.revision + 1,
        defaultProxy,
        defaultMode,
        byedpiEnabled: defaultMode === 'byedpi',
      }),
    });
    return read();
  };
  let writes = Promise.resolve();
  return {
    read,
    /** Startup failures stay visible and retry without silently changing the saved policy. */
    async initialize() {
      if (read().byedpi?.enabled) await byedpi?.ensureRunning().catch(() => {});
    },
    async close() {
      await writes;
      await byedpi?.stop();
    },
    save(input: SourceNetworkSettingsRequest): SourceNetworkSettings | Promise<SourceNetworkSettings> {
      const defaultProxy = validate(input);
      const mode = selection(input, defaultProxy);
      // Preserve the existing synchronous host API when no process controller was supplied.
      if (!byedpi) {
        if (mode === 'byedpi') throw new Error('byedpi_unavailable');
        return persist(input, defaultProxy, mode);
      }
      const operation = writes.then(async () => {
        validate(input);
        const previousEnabled = read().byedpi?.enabled === true;
        const enabled = mode === 'byedpi';
        try {
          if (enabled) await byedpi.ensureRunning();
          persist(input, defaultProxy, mode);
          if (!enabled) await byedpi.stop();
          return read();
        } catch (error) {
          if (!previousEnabled) await byedpi.stop();
          throw error;
        }
      });
      writes = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    resolve(options: SourceProxyOptions = {}): string | undefined {
      const mode = options.proxyMode ?? (options.outboundProxy ? 'custom' : 'inherit');
      if (mode === 'direct') return undefined;
      if (mode === 'custom') {
        const proxy = parseOutboundProxy(options.outboundProxy);
        if (!proxy) throw new Error('compatibility_preferences_invalid');
        return proxy;
      }
      const settings = read();
      if (settings.byedpi?.enabled && !byedpi) throw new Error('byedpi_unavailable');
      return settings.effectiveProxy || undefined;
    },
  };
}
