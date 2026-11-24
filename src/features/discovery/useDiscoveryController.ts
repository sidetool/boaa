import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useOptionalSelfHostAuth } from '../auth/SelfHostAccountGate';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { DiscoverySettingsStore } from './discovery-settings-store';
import { DiscoverySession } from './discovery-session';
export function useDiscoveryController(
  registry: ExternalSourceRegistryPort,
  context: TrustedExternalSourceHostContext,
  serverScope = 'local',
  client?: RemoteApiClient,
) {
  const auth = useOptionalSelfHostAuth();
  const scope =
    auth?.session?.storageScope ??
    `${globalThis.location?.origin ?? 'local'}:${serverScope}:${auth?.account.username ?? 'local'}`;
  const [active, setActive] = useState(false);
  const store = useMemo(
    () =>
      new DiscoverySettingsStore(
        scope,
        client,
        globalThis.window?.localStorage,
        !auth?.session || auth.session.context.legacyDataOwner,
      ),
    [scope, client, auth?.session],
  );
  const shared = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.mount(), [store]);
  useEffect(() => {
    if (!active || !client) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void store.refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, client, store]);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  // A clear retires the in-flight session even when its registry and account have not changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session = useMemo(() => new DiscoverySession(registry, context, scope), [registry, context, scope, cacheEpoch]);
  useEffect(() => session.mount(() => setCacheEpoch((value) => value + 1)), [session]);
  return {
    active,
    setActive,
    scope,
    session,
    ...shared,
    refresh: store.refresh,
    save: store.save,
  };
}
export type DiscoveryController = ReturnType<typeof useDiscoveryController>;
