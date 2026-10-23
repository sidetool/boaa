import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useProductPlugins } from '../../extensions/platform/PlatformPluginProvider';
import { HomePluginLoader, type HomePluginAdapter } from './plugin-home';

const subscribeEmpty = () => () => undefined;
const emptySnapshot = () => 0;
const loaders = new WeakMap<object, HomePluginLoader>();

export function usePluginHome(): HomePluginAdapter | undefined {
  const { session } = useProductPlugins();
  const service = session?.service;
  const loader = useMemo(() => {
    if (!service) return undefined;
    let value = loaders.get(service);
    if (!value) {
      value = new HomePluginLoader(service);
      loaders.set(service, value);
    }
    return value;
  }, [service]);
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
      loader.suspend();
    };
  }, [loader, service]);
  return useMemo(
    () => (loader ? { revision, sections: loader.sections, row: (config) => loader.row(config) } : undefined),
    [loader, revision],
  );
}
