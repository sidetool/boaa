import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useProductPlugins } from '../../extensions/platform/PlatformPluginProvider';
import { HomePluginLoader, type HomePluginAdapter } from './plugin-home';

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => 0;

export function usePluginHome(): HomePluginAdapter | undefined {
  const { session } = useProductPlugins();
  const service = session?.service;
  const loader = useMemo(() => (service ? new HomePluginLoader(service) : undefined), [service]);
  const revision = useSyncExternalStore(
    loader?.subscribe ?? subscribeEmpty,
    loader?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  useEffect(() => {
    if (!loader || !service) return;
    loader.resume();
    const sync = () => {
      void loader.sync();
    };
    const unsubscribe = service.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      loader.dispose();
    };
  }, [loader, service]);
  return useMemo(
    () => (loader ? { revision, sections: loader.sections, row: (config) => loader.row(config) } : undefined),
    [loader, revision],
  );
}
