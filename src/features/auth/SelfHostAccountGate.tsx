import { invalidateSharedParagraphPages } from '../reader/shared-paragraph-pages';
import { clearSourceMetadataCache } from '../../external-sources/local-state';
import {
  Suspense,
  lazy,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { ReaderRuntime } from '../../repositories/reader-runtime';
import {
  SELF_HOST_AUTH_ENDING_EVENT,
  SELF_HOST_AUTH_REQUIRED_EVENT,
} from '../../services/remote/self-host-auth-events';
import { SelfHostAuthClient, selfHostAuthErrorMessage, type SelfHostAccount } from './self-host-auth-client';

const UiNextAuthScreen = lazy(() =>
  import('../../ui-next/auth/UiNextAuthScreen').then((module) => ({ default: module.UiNextAuthScreen })),
);

interface SelfHostAuthContextValue {
  readonly account: SelfHostAccount;
  readonly logout: () => Promise<void>;
}

const SelfHostAuthContext = createContext<SelfHostAuthContextValue | undefined>(undefined);

export function useOptionalSelfHostAuth(): SelfHostAuthContextValue | undefined {
  return useContext(SelfHostAuthContext);
}

interface SelfHostAccountGateProps {
  readonly runtime: ReaderRuntime;
  readonly children: ReactNode;
}

type GateMode = 'loading' | 'setup' | 'login' | 'authenticated' | 'error';

export function SelfHostAccountGate({ runtime, children }: SelfHostAccountGateProps) {
  const client = useMemo(
    () =>
      runtime.mode === 'remote' && !runtime.managedByDesktop
        ? new SelfHostAuthClient(runtime.apiBaseUrl ?? '/api')
        : undefined,
    [runtime.apiBaseUrl, runtime.mode, runtime.managedByDesktop],
  );
  const [mode, setMode] = useState<GateMode>(runtime.mode === 'remote' ? 'loading' : 'authenticated');
  const [account, setAccount] = useState<SelfHostAccount>();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [setupCodeSource, setSetupCodeSource] = useState<'server-log' | null>();
  const [legacySetupCodeAccepted, setLegacySetupCodeAccepted] = useState<boolean>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!client) return;
    invalidateSharedParagraphPages(runtime.readerRepository);
    setMode('loading');
    setMessage('');
    try {
      const status = await client.status();
      setSetupCodeRequired(status.setupCodeRequired);
      setSetupCodeSource(status.setupCodeSource);
      setLegacySetupCodeAccepted(status.legacySetupCodeAccepted);
      if (status.authenticated && status.account) {
        invalidateSharedParagraphPages(runtime.readerRepository);
        setAccount(status.account);
        setMode('authenticated');
      } else {
        setAccount(undefined);
        setMode(status.setupRequired ? 'setup' : 'login');
      }
    } catch (error) {
      setMode('error');
      setMessage(selfHostAuthErrorMessage(error));
    }
  }, [client, runtime.readerRepository]);

  useEffect(() => {
    if (!client) return;
    void refresh();
  }, [client, refresh]);

  useEffect(() => {
    if (!client) return;
    const clearBody = () => invalidateSharedParagraphPages(runtime.readerRepository);
    const requireLogin = () => {
      clearBody();
      setAccount(undefined);
      setMode('login');
      setMessage('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
    };
    globalThis.addEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
    globalThis.addEventListener?.(SELF_HOST_AUTH_ENDING_EVENT, clearBody);
    return () => {
      globalThis.removeEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
      globalThis.removeEventListener?.(SELF_HOST_AUTH_ENDING_EVENT, clearBody);
    };
  }, [client, runtime.readerRepository]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || submitting) return;
    if (mode === 'setup' && password !== passwordConfirmation) {
      setMessage('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setSubmitting(true);
    setMessage('');
    try {
      const next =
        mode === 'setup'
          ? await client.register({
              username,
              displayName: displayName || undefined,
              password,
              setupCode: setupCode || undefined,
            })
          : await client.login({ username, password });
      invalidateSharedParagraphPages(runtime.readerRepository);
      setAccount(next);
      setPassword('');
      setPasswordConfirmation('');
      setSetupCode('');
      setMode('authenticated');
    } catch (error) {
      setMessage(selfHostAuthErrorMessage(error));
      if (error instanceof Error && error.message === 'account_already_registered') setMode('login');
    } finally {
      setSubmitting(false);
    }
  };

  const logout = useCallback(async () => {
    if (!client) return;
    invalidateSharedParagraphPages(runtime.readerRepository);
    await client.logout();
    setAccount(undefined);
    setPassword('');
    setMode('login');
    await clearSourceMetadataCache().catch(() => undefined);
  }, [client, runtime.readerRepository]);

  if (!client) return children;
  if (mode === 'authenticated' && account) {
    return <SelfHostAuthContext.Provider value={{ account, logout }}>{children}</SelfHostAuthContext.Provider>;
  }

  if (mode !== 'authenticated') {
    return (
      <Suspense fallback={null}>
        <UiNextAuthScreen
          mode={mode}
          message={message}
          submitting={submitting}
          setupCodeRequired={setupCodeRequired}
          setupCodeSource={setupCodeSource}
          legacySetupCodeAccepted={legacySetupCodeAccepted}
          username={username}
          displayName={displayName}
          password={password}
          passwordConfirmation={passwordConfirmation}
          setupCode={setupCode}
          onUsername={setUsername}
          onDisplayName={setDisplayName}
          onPassword={setPassword}
          onPasswordConfirmation={setPasswordConfirmation}
          onSetupCode={setSetupCode}
          onSubmit={(event) => void submit(event)}
          onRetry={() => void refresh()}
        />
      </Suspense>
    );
  }
  return null;
}
