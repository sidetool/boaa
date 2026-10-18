import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptionalSelfHostAuth } from '../../features/auth/SelfHostAccountGate';
import {
  SELF_HOST_AUTH_REQUIRED_EVENT,
  SELF_HOST_AUTH_ENDING_EVENT,
} from '../../services/remote/self-host-auth-events';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import { requireEnvironment } from '../ui/runtime-policy';
import { loadPluginDeployment, ProductPluginSession } from './product-session';
interface ProductPlugins {
  session?: ProductPluginSession;
  message: string;
  code?: string;
  retry(): void;
}
const Context = createContext<ProductPlugins>({
  message: '이 환경에서는 JS 플러그인을 사용할 수 없습니다.',
  retry() {},
});
export const useProductPlugins = () => useContext(Context);
export function PlatformPluginProvider({ runtime, children }: { runtime: ReaderRuntime; children: ReactNode }) {
  const account = useOptionalSelfHostAuth()?.account;
  const owner = useMemo(
    () => ({ account, apiBaseUrl: runtime.apiBaseUrl, mode: runtime.mode, managedByDesktop: runtime.managedByDesktop }),
    [account, runtime.apiBaseUrl, runtime.mode, runtime.managedByDesktop],
  );
  const [state, setState] = useState<{
    session?: ProductPluginSession;
    message: string;
    code?: string;
    owner?: object;
  }>({
    message: '플러그인 환경 확인 중',
  });
  const [attempt, setAttempt] = useState(0);
  const previous = useRef(Promise.resolve());
  useEffect(() => {
    let disposed = false,
      session: ProductPluginSession | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const requests = new Set<AbortController>();
    const stop = () => {
      disposed = true;
      clearTimeout(timer);
      requests.forEach((c) => c.abort());
      if (session) previous.current = session.close();
    };
    const fail = (message: string) => {
      stop();
      setState({ message, ...(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(message) ? { code: message } : {}) });
    };
    const fetchContext = async () => {
      const controller = new AbortController();
      requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        return await loadPluginDeployment(
          runtime.apiBaseUrl ?? '/api',
          controller.signal,
          runtime.session?.fetch.bind(runtime.session),
        );
      } finally {
        clearTimeout(timeout);
        requests.delete(controller);
      }
    };
    const check = async () => {
      try {
        const next = await fetchContext();
        if (disposed) return;
        const active = session?.deployment;
        if (
          !active ||
          (['version', 'origin', 'serverId', 'accountId', 'libraryId', 'worker', 'wasm', 'shell'] as const).some(
            (key) => next[key] !== active[key],
          )
        ) {
          fail('계정 또는 서버 정보가 바뀌었습니다. 플러그인을 중지했습니다. 다시 확인해 주세요.');
          return;
        }
        timer = setTimeout(() => void check(), 5000);
      } catch {
        if (!disposed) fail('인증 상태를 확인할 수 없어 플러그인을 중지했습니다.');
      }
    };
    const start = async () => {
      setState({ message: '플러그인 환경 확인 중' });
      if (!account || runtime.mode !== 'remote' || runtime.managedByDesktop) {
        fail('JS 플러그인은 로그인한 self-host 브라우저에서 지원합니다.');
        return;
      }
      try {
        requireEnvironment(window, 'self-host', true);
        await previous.current;
        if (disposed) return;
        const deployment = await fetchContext();
        if (disposed) return;
        const expected = runtime.session?.context;
        if (
          expected &&
          (deployment.serverId !== expected.serverId ||
            deployment.accountId !== expected.accountId ||
            deployment.libraryId !== expected.libraryId)
        )
          throw new Error('PLUGIN_DEPLOYMENT_MISMATCH');
        session = new ProductPluginSession(deployment, window, runtime.session?.fetch.bind(runtime.session));
        await session.store.finishRetirements();
        if (disposed) return;
        await session.service.startSession();
        if (disposed) return;
        setState({ session, owner, message: session.off ? '안전 모드: 플러그인 실행이 중지되어 있습니다.' : '' });
        timer = setTimeout(() => void check(), 5000);
      } catch (error) {
        if (!disposed) fail(error instanceof Error ? error.message : '플러그인을 준비하지 못했습니다.');
      }
    };
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('boaa.plugin-auth.v1') : undefined;
    const expired = (event: Event) => {
      const epoch = (event as CustomEvent<{ epoch?: string }>).detail?.epoch;
      if (epoch && epoch !== runtime.session?.epoch) return;
      channel?.postMessage('stop');
      fail('로그인이 종료되어 플러그인을 중지했습니다.');
    };
    if (channel) channel.onmessage = () => fail('다른 창에서 계정 상태가 바뀌어 플러그인을 중지했습니다.');
    const pagehide = () => stop();
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) setAttempt((n) => n + 1);
    };
    window.addEventListener(SELF_HOST_AUTH_REQUIRED_EVENT, expired);
    window.addEventListener(SELF_HOST_AUTH_ENDING_EVENT, expired);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    void start();
    return () => {
      stop();
      window.removeEventListener(SELF_HOST_AUTH_REQUIRED_EVENT, expired);
      window.removeEventListener(SELF_HOST_AUTH_ENDING_EVENT, expired);
      channel?.close();
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    };
  }, [runtime.apiBaseUrl, runtime.mode, runtime.managedByDesktop, account, owner, attempt, runtime.session]);
  return (
    <Context.Provider
      value={{
        ...state,
        session: state.owner === owner ? state.session : undefined,
        retry: () => setAttempt((n) => n + 1),
      }}
    >
      {children}
    </Context.Provider>
  );
}
