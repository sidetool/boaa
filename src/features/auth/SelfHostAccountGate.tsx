import { invalidateSharedParagraphPages } from '../reader/shared-paragraph-pages';
import { SelfHostSession, type SelfHostAuthenticatedContext } from './self-host-session';
import {
  Suspense,
  lazy,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import type { ReaderRuntime } from '../../repositories/reader-runtime';
import {
  SELF_HOST_AUTH_ENDING_EVENT,
  SELF_HOST_AUTH_REQUIRED_EVENT,
} from '../../services/remote/self-host-auth-events';
import {
  SelfHostAuthClient,
  SelfHostAuthClientError,
  selfHostAuthErrorMessage,
  type SelfHostAccount,
} from './self-host-auth-client';

const UiNextAuthScreen = lazy(() =>
  import('../../ui-next/auth/UiNextAuthScreen').then((module) => ({ default: module.UiNextAuthScreen })),
);
const UiNextAccountTokenScreen = lazy(() =>
  import('../../ui-next/auth/UiNextAccountTokenScreen').then((module) => ({
    default: module.UiNextAccountTokenScreen,
  })),
);
const UiNextLogoutPendingScreen = lazy(() =>
  import('../../ui-next/auth/UiNextAccountTokenScreen').then((module) => ({
    default: module.UiNextLogoutPendingScreen,
  })),
);
const UiNextAuthLock = lazy(() =>
  import('../../ui-next/auth/UiNextAccountTokenScreen').then((module) => ({ default: module.UiNextAuthLock })),
);

interface SelfHostAuthContextValue {
  readonly account: SelfHostAccount;
  readonly session?: SelfHostSession;
  readonly logout: () => Promise<void>;
  /** Re-reads the server session. Keeps the runtime when nothing changed; replaces it when the session rotated. */
  readonly revalidate: () => Promise<void>;
}

const SelfHostAuthContext = createContext<SelfHostAuthContextValue | undefined>(undefined);

export function useOptionalSelfHostAuth(): SelfHostAuthContextValue | undefined {
  return useContext(SelfHostAuthContext);
}

interface SelfHostAccountGateProps {
  readonly runtime?: ReaderRuntime;
  readonly apiBaseUrl?: string;
  readonly children: ReactNode | ((session: SelfHostSession) => ReactNode);
}

type GateMode = 'loading' | 'setup' | 'login' | 'authenticated' | 'error' | 'logout-pending';

/** A tab hidden longer than this is covered until its account is confirmed again. */
const LOCK_AFTER_HIDDEN_MS = 60_000;

/** Non-secret record of a sign-out the server has not confirmed. Bound to the session it was meant to end. */
interface LogoutIntent {
  readonly serverId: string;
  readonly userId: string;
  readonly sessionContext: string;
}

function intentOf(context: SelfHostAuthenticatedContext): LogoutIntent {
  return { serverId: context.serverId, userId: context.account.userId, sessionContext: context.sessionContext };
}

function sameIntent(intent: LogoutIntent, context: SelfHostAuthenticatedContext): boolean {
  const current = intentOf(context);
  return (
    intent.serverId === current.serverId &&
    intent.userId === current.userId &&
    intent.sessionContext === current.sessionContext
  );
}

/** Same server session and the same authority: the running app may keep going. */
function sameRuntime(a: SelfHostAuthenticatedContext, b: SelfHostAuthenticatedContext): boolean {
  return (
    a.sessionContext === b.sessionContext &&
    a.serverId === b.serverId &&
    a.libraryId === b.libraryId &&
    a.accountId === b.accountId &&
    a.account.userId === b.account.userId &&
    a.account.role === b.account.role &&
    a.legacyDataOwner === b.legacyDataOwner &&
    JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities)
  );
}

function redemptionErrorMessage(code: unknown, status: number): string {
  switch (code) {
    case 'invalid_token':
      return '이 링크는 이미 썼거나 만료됐어요. 관리자에게 새 링크를 부탁해 주세요.';
    case 'invalid_password':
      return '비밀번호는 10자 이상 256자 이하로 정해 주세요.';
    case 'login_rate_limited':
      return '시도가 너무 많았어요. 5분 뒤에 다시 해 주세요.';
    default:
      return status >= 500
        ? '서버가 요청을 처리하지 못했어요. 잠시 뒤 다시 해 주세요.'
        : '이 링크를 쓸 수 없어요. 관리자에게 새 링크를 부탁해 주세요.';
  }
}

type AccountLink = { readonly kind: 'invitation' | 'password-reset'; readonly token: string };
/** `null` until the address is read once; then the link (or nothing) for this page's lifetime only. */
let pageAccountLink: AccountLink | undefined | null = null;

/**
 * Reads an invitation/reset token from the address once and strips it from history immediately. The token
 * stays in memory so StrictMode or a remount cannot lose it; it is never written to storage.
 */
function takeAccountLink(): AccountLink | undefined {
  if (pageAccountLink !== null) return pageAccountLink;
  pageAccountLink = undefined;
  if (!globalThis.location) return undefined;
  const url = new URL(globalThis.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const kind: AccountLink['kind'] =
    hash.has('invitation') || url.searchParams.has('invitation') ? 'invitation' : 'password-reset';
  const token = hash.get(kind) ?? url.searchParams.get(kind);
  if (!token) return undefined;
  url.hash = '';
  url.searchParams.delete(kind);
  history.replaceState(null, '', url.pathname + url.search);
  pageAccountLink = { kind, token };
  return pageAccountLink;
}

/** Forget the token once it was used or dismissed, so a later mount cannot offer it again. */
function releaseAccountLink(): void {
  pageAccountLink = undefined;
}

/** Test seam: forget what this page read so a fresh address can be read again. */
export function resetAccountLinkForTests(): void {
  pageAccountLink = null;
}

export function SelfHostAccountGate({ runtime, apiBaseUrl, children }: SelfHostAccountGateProps) {
  const baseUrl = apiBaseUrl ?? runtime?.apiBaseUrl ?? '/api';
  // Only these primitives decide the client, so a new runtime object alone does not rebuild it.
  const accountMode = (!runtime || runtime.mode === 'remote') && !runtime?.managedByDesktop;
  const client = useMemo(() => (accountMode ? new SelfHostAuthClient(baseUrl) : undefined), [accountMode, baseUrl]);
  const intentKey = `boaa.logout-pending:${baseUrl}`;
  const readIntent = useCallback((): LogoutIntent | undefined => {
    try {
      const value = JSON.parse(sessionStorage.getItem(intentKey) ?? 'null') as Partial<LogoutIntent> | null;
      return value && typeof value.sessionContext === 'string' && typeof value.userId === 'string'
        ? (value as LogoutIntent)
        : undefined;
    } catch {
      return undefined;
    }
  }, [intentKey]);
  const writeIntent = useCallback(
    (intent: LogoutIntent | undefined) => {
      try {
        if (intent) sessionStorage.setItem(intentKey, JSON.stringify(intent));
        else sessionStorage.removeItem(intentKey);
      } catch {
        /* unavailable */
      }
    },
    [intentKey],
  );
  const [redemption, setRedemptionState] = useState(takeAccountLink);
  const setRedemption = (next: undefined) => {
    releaseAccountLink();
    setRedemptionState(next);
  };
  const [mode, setMode] = useState<GateMode>(!runtime || runtime.mode === 'remote' ? 'loading' : 'authenticated');
  /** Covers the still-mounted app while a returning tab re-checks; `failed` when the server was unreachable. */
  const [locked, setLocked] = useState<'checking' | 'failed'>();
  const tabId = useRef(crypto.randomUUID());
  const sessionRef = useRef<SelfHostSession>();
  const [session, setSession] = useState<SelfHostSession>();
  const pendingContext = useRef<SelfHostAuthenticatedContext>();
  const refreshGeneration = useRef(0);
  const hiddenAt = useRef<number>();
  const coveredTitle = useRef<string>();
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
  const [messageTone, setMessageTone] = useState<'error' | 'success'>('error');
  const showMessage = (text: string, tone: 'error' | 'success' = 'error') => {
    setMessage(text);
    setMessageTone(tone);
  };

  const unlock = () => {
    setLocked(undefined);
    if (coveredTitle.current !== undefined && globalThis.document) document.title = coveredTitle.current;
    coveredTitle.current = undefined;
  };

  /** Ends a runtime's lifetime: aborts its requests and drops cached private body pages. */
  const endSession = useCallback(
    (ended: SelfHostSession | undefined) => {
      if (runtime) invalidateSharedParagraphPages(runtime.readerRepository);
      if (!ended) return;
      ended.dispose();
      if (sessionRef.current === ended) sessionRef.current = undefined;
      setSession((current) => (current === ended ? undefined : current));
    },
    [runtime],
  );

  /**
   * Asks the server who is signed in. A live runtime whose session is unchanged keeps running (playback,
   * drafts and work continue); only a different session, a sign-out or an unauthenticated answer ends it.
   */
  const refresh = useCallback(
    async (options: { lock?: boolean; ended?: boolean } = {}) => {
      if (!client) return;
      const generation = ++refreshGeneration.current;
      const live = sessionRef.current;
      if (live) {
        if (options.lock) setLocked('checking');
      } else {
        if (runtime) invalidateSharedParagraphPages(runtime.readerRepository);
        setMode('loading');
        if (!options.ended) setMessage('');
      }
      try {
        const status = await client.status();
        if (generation !== refreshGeneration.current) return;
        setSetupCodeRequired(status.setupCodeRequired);
        setSetupCodeSource(status.setupCodeSource);
        setLegacySetupCodeAccepted(status.legacySetupCodeAccepted);
        if (status.authenticated && status.account) {
          const context = status.context ?? (status as unknown as SelfHostAuthenticatedContext);
          if (!context.sessionContext || !context.account?.userId || !context.serverId)
            throw new Error('서버 계정 식별 정보를 확인할 수 없습니다. 서버를 업데이트해 주세요.');
          const intent = readIntent();
          if (intent && sameIntent(intent, context)) {
            // The sign-out this tab asked for has not happened yet: keep the app closed and offer a retry.
            endSession(live);
            pendingContext.current = context;
            setAccount(status.account);
            unlock();
            setMode('logout-pending');
            return;
          }
          // An intent for another session (or account) is stale; never use it against this one.
          if (intent) writeIntent(undefined);
          pendingContext.current = undefined;
          if (live && sessionRef.current === live && sameRuntime(live.context, context)) {
            setAccount(status.account);
            unlock();
            setMode('authenticated');
            return;
          }
          endSession(live);
          const nextSession = new SelfHostSession(context, baseUrl);
          sessionRef.current = nextSession;
          setSession(nextSession);
          setAccount(status.account);
          setMessage('');
          unlock();
          setMode('authenticated');
        } else {
          writeIntent(undefined);
          pendingContext.current = undefined;
          endSession(live);
          setAccount(undefined);
          unlock();
          if (live || options.ended) showMessage('로그인이 끝났어요. 다시 로그인해 주세요.');
          setMode(status.setupRequired ? 'setup' : 'login');
        }
      } catch (error) {
        if (generation !== refreshGeneration.current) return;
        if (live && sessionRef.current === live) {
          // Unreachable is not signed out: the running app stays, covered only if it already was.
          setLocked((current) => (current ? 'failed' : undefined));
          return;
        }
        setMode('error');
        showMessage(selfHostAuthErrorMessage(error));
      }
    },
    [client, runtime, baseUrl, readIntent, writeIntent, endSession],
  );

  useEffect(() => {
    if (!client) return;
    void refresh();
  }, [client, refresh]);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  useEffect(() => {
    if (!client) return;
    const clearBody = () => {
      if (runtime) invalidateSharedParagraphPages(runtime.readerRepository);
    };
    const requireLogin = (event: Event) => {
      const epoch = (event as CustomEvent<{ epoch?: string }>).detail?.epoch;
      if (epoch && epoch !== sessionRef.current?.epoch) return;
      // 401 or a context mismatch ends this runtime. Ask the server what replaced it instead of guessing.
      endSession(sessionRef.current);
      setAccount(undefined);
      void refresh({ ended: true });
    };
    globalThis.addEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
    globalThis.addEventListener?.(SELF_HOST_AUTH_ENDING_EVENT, clearBody);
    return () => {
      globalThis.removeEventListener?.(SELF_HOST_AUTH_REQUIRED_EVENT, requireLogin);
      globalThis.removeEventListener?.(SELF_HOST_AUTH_ENDING_EVENT, clearBody);
    };
  }, [client, runtime, refresh, endSession]);

  const channelName = `boaa.auth:${baseUrl}`;
  const announce = () => {
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : undefined;
    channel?.postMessage({ changed: true, sender: tabId.current });
    channel?.close();
    try {
      localStorage.setItem(channelName, crypto.randomUUID());
    } catch {
      /* unavailable */
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || submitting) return;
    if (mode === 'setup' && password !== passwordConfirmation) {
      showMessage('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    setSubmitting(true);
    setMessage('');
    try {
      if (mode === 'setup')
        await client.register({
          username,
          displayName: displayName || undefined,
          password,
          setupCode: setupCode || undefined,
        });
      else await client.login({ username, password });
      if (runtime) invalidateSharedParagraphPages(runtime.readerRepository);
      setPassword('');
      setPasswordConfirmation('');
      setSetupCode('');
      await refresh();
      announce();
    } catch (error) {
      showMessage(selfHostAuthErrorMessage(error));
      if (error instanceof Error && error.message === 'account_already_registered') setMode('login');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!client) return;
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : undefined;
    let inFlight: Promise<void> | undefined;
    const check = (lock: boolean) => {
      // Focus and visibility arrive together; one quiet check is enough unless the page must be covered.
      if (inFlight && !lock) return;
      const current = refresh({ lock });
      inFlight = current;
      void current.finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
    };
    const cover = () => {
      if (!sessionRef.current) return;
      if (globalThis.document && coveredTitle.current === undefined) {
        coveredTitle.current = document.title;
        document.title = 'BOAA';
      }
      flushSync(() => setLocked('checking'));
    };
    // Another tab signed in or out: the account here may have changed underneath.
    if (channel)
      channel.onmessage = (event) => {
        if (event.data?.sender !== tabId.current) check(true);
      };
    const storage = (event: StorageEvent) => {
      if (event.key === channelName) check(true);
    };
    const focus = () => check(false);
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current === undefined ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = undefined;
      check(away >= LOCK_AFTER_HIDDEN_MS);
    };
    // A page entering the back/forward cache is covered first, so a restore never shows the old screen.
    const hide = (event: PageTransitionEvent) => {
      if (event.persisted) cover();
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) check(true);
    };
    globalThis.document?.addEventListener('visibilitychange', visibility);
    globalThis.addEventListener?.('storage', storage);
    globalThis.addEventListener?.('focus', focus);
    globalThis.addEventListener?.('pagehide', hide);
    globalThis.addEventListener?.('pageshow', show);
    return () => {
      globalThis.document?.removeEventListener('visibilitychange', visibility);
      channel?.close();
      globalThis.removeEventListener?.('storage', storage);
      globalThis.removeEventListener?.('focus', focus);
      globalThis.removeEventListener?.('pagehide', hide);
      globalThis.removeEventListener?.('pageshow', show);
    };
  }, [client, refresh, channelName]);

  const logout = useCallback(async () => {
    if (!client) return;
    const old = sessionRef.current;
    const context = old?.context ?? pendingContext.current;
    const shown = account;
    ++refreshGeneration.current;
    endSession(old);
    if (context) writeIntent(intentOf(context));
    unlock();
    setPassword('');
    setMessage('');
    setSubmitting(true);
    setMode(context && pendingContext.current ? 'logout-pending' : 'loading');
    try {
      await client.logout(context?.sessionContext);
      writeIntent(undefined);
      pendingContext.current = undefined;
      setAccount(undefined);
      setMode('login');
      announce();
    } catch (error) {
      if (
        error instanceof SelfHostAuthClientError &&
        (error.status === 401 || error.code === 'session_context_mismatch')
      ) {
        // That session is already gone from this browser; check what is signed in now instead.
        writeIntent(undefined);
        pendingContext.current = undefined;
        setAccount(undefined);
        await refresh();
        return;
      }
      pendingContext.current = context;
      setAccount(shown);
      setMode(context && shown ? 'logout-pending' : 'error');
      showMessage(`로그아웃을 서버에서 확인하지 못했어요. ${selfHostAuthErrorMessage(error)}`);
      throw error;
    } finally {
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channelName, account, endSession, writeIntent, refresh]);

  const redeem = (event: FormEvent) => {
    event.preventDefault();
    if (!redemption || submitting) return;
    if (password !== passwordConfirmation) {
      showMessage('비밀번호 두 칸이 달라요.');
      return;
    }
    setSubmitting(true);
    setMessage('');
    const path = redemption.kind === 'invitation' ? 'invitations/accept' : 'password-reset/complete';
    void fetch(`${baseUrl}/auth/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: redemption.token, password }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          error?: unknown;
          username?: unknown;
          displayName?: unknown;
        };
        if (response.status === 409 && data.error === 'account_session_active') {
          // Another tab signed in meanwhile; show who, so they can sign out first.
          showMessage('다른 창에서 로그인했어요. 먼저 로그아웃해 주세요.');
          await refresh();
          return;
        }
        if (!response.ok) {
          showMessage(redemptionErrorMessage(data.error, response.status));
          return;
        }
        setRedemption(undefined);
        setPassword('');
        setPasswordConfirmation('');
        // The server names the account only after a valid redemption, so the login form can be filled in.
        if (typeof data.username === 'string') setUsername(data.username);
        const name = typeof data.displayName === 'string' && data.displayName ? `${data.displayName}님, ` : '';
        showMessage(
          redemption.kind === 'invitation'
            ? `${name}비밀번호를 정했어요. ${typeof data.username === 'string' ? '' : '관리자가 알려 준 아이디로 '}로그인해 주세요.`
            : `${name}새 비밀번호를 정했어요. 로그인해 주세요.`,
          'success',
        );
        setMode('login');
      })
      .catch(() => showMessage('개인 서버에 연결하지 못했어요. 연결을 확인하고 다시 해 주세요.'))
      .finally(() => setSubmitting(false));
  };

  if (!client) return typeof children === 'function' ? null : children;

  if (mode === 'logout-pending' && account)
    return (
      <Suspense fallback={null}>
        <UiNextLogoutPendingScreen
          account={account}
          submitting={submitting}
          message={message}
          onRetry={() => void logout().catch(() => undefined)}
        />
      </Suspense>
    );

  if (redemption && (mode === 'login' || mode === 'setup' || (mode === 'authenticated' && account)))
    return (
      <Suspense fallback={null}>
        <UiNextAccountTokenScreen
          kind={redemption.kind}
          signedIn={mode === 'authenticated' ? account : undefined}
          password={password}
          passwordConfirmation={passwordConfirmation}
          submitting={submitting}
          message={message}
          onPassword={setPassword}
          onPasswordConfirmation={setPasswordConfirmation}
          onSubmit={redeem}
          onSignOut={() => void logout().catch(() => undefined)}
          onDismiss={() => {
            setRedemption(undefined);
            setMessage('');
          }}
        />
      </Suspense>
    );

  if (mode === 'authenticated' && account) {
    return (
      <SelfHostAuthContext.Provider value={{ account, session, logout, revalidate: () => refresh() }}>
        <div className="self-host-app" style={{ display: 'contents' }} {...(locked ? { inert: '' } : {})}>
          {typeof children === 'function' ? session && children(session) : children}
        </div>
        {locked && (
          <Suspense fallback={<div className="ui-next un-auth-lock" />}>
            <UiNextAuthLock failed={locked === 'failed'} onRetry={() => void refresh({ lock: true })} />
          </Suspense>
        )}
      </SelfHostAuthContext.Provider>
    );
  }

  if (mode !== 'authenticated') {
    return (
      <Suspense fallback={null}>
        <UiNextAuthScreen
          mode={mode === 'logout-pending' ? 'loading' : mode}
          message={message}
          messageTone={messageTone}
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
