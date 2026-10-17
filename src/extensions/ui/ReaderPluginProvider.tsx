import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ReaderPluginHost, type ReaderPluginSnapshot } from './reader-plugin-host';
const Context = createContext<ReaderPluginHost | undefined>(undefined);
const empty: ReaderPluginSnapshot = { entries: [], reader: null, shareSequence: 0 };
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};
/** Mount below a verified auth/scope gate with a stable factory. No default product enablement. */
export function ReaderPluginProvider({
  createHost,
  children,
}: {
  createHost: () => ReaderPluginHost;
  children: ReactNode;
}) {
  const [owned, setOwned] = useState<{ factory: typeof createHost; host: ReaderPluginHost }>();
  const previous = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => {
    let current = true,
      host: ReaderPluginHost | undefined;
    const started = previous.current.then(() => {
      if (!current) return;
      host = createHost();
      setOwned({ factory: createHost, host });
    });
    void started.catch(() => {
      if (current) setOwned(undefined);
    });
    return () => {
      current = false;
      // Revoke synchronously when an owner exists, then serialize replacement scope setup.
      const stopping = host?.dispose();
      previous.current = started
        .catch(() => {})
        .then(() => stopping)
        .catch(() => {});
    };
  }, [createHost]);
  const host = owned?.factory === createHost ? owned.host : undefined;
  useEffect(() => {
    if (!host) return;
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      void host
        .refresh()
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    const interval = window.setInterval(refresh, 2000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [host]);
  return <Context.Provider value={host}>{children}</Context.Provider>;
}
export function useReaderPlugins() {
  const host = useContext(Context);
  const snapshot = useSyncExternalStore(
    host?.subscribe ?? noSubscribe,
    host?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return { host, snapshot };
}
export function useReaderPluginPanelSelection(tab: string | null) {
  const plugins = useReaderPlugins();
  useLayoutEffect(() => {
    plugins.host?.selectPanel(tab);
  }, [plugins.host, tab]);
  return plugins;
}
