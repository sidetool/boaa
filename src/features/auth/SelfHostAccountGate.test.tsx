import { StrictMode, useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { resetAccountLinkForTests, SelfHostAccountGate, useOptionalSelfHostAuth } from './SelfHostAccountGate';
import { SelfHostAuthClient } from './self-host-auth-client';
import { loadSharedParagraphPage } from '../reader/shared-paragraph-pages';
import {
  SELF_HOST_AUTH_ENDING_EVENT,
  SELF_HOST_AUTH_REQUIRED_EVENT,
} from '../../services/remote/self-host-auth-events';
import type { ReaderRuntime } from '../../repositories/reader-runtime';
import type { ParagraphPage } from '../../domain/types';

vi.mock('../../external-sources/local-state', () => ({ clearSourceMetadataCache: vi.fn(async () => {}) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const page = (text: string) => ({ paragraphs: [{ index: 1, text }] }) as ParagraphPage;

it.each(['logout', 'expired'] as const)(
  'discards cached and pending body pages across %s and reauthentication',
  async (boundary) => {
    const events = new EventTarget();
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
    vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
    const account = { userId: 'fixture-id', role: 'admin' as const, username: 'fixture', displayName: 'Fixture' };
    const status = vi.spyOn(SelfHostAuthClient.prototype, 'status').mockResolvedValue({
      context: {
        account,
        serverId: 'server',
        libraryId: 'library',
        accountId: 'plugin',
        sessionContext: 'session',
        capabilities: {
          manageServer: false,
          manageExtensions: false,
          useSources: true,
          useProviders: false,
          exportLibrary: true,
          restoreLibrary: false,
          manageAccounts: true,
        },
        legacyDataOwner: true,
      },
      authenticated: true,
      account,
      setupRequired: false,
      legacyRecoveryEnabled: false,
      setupCodeRequired: false,
    });
    vi.spyOn(SelfHostAuthClient.prototype, 'login').mockResolvedValue(account);
    vi.spyOn(SelfHostAuthClient.prototype, 'logout').mockImplementation(async () => {
      dispatchEvent(new Event(SELF_HOST_AUTH_ENDING_EVENT));
    });
    let resolveOld!: (value: ParagraphPage) => void;
    const loader = vi.fn().mockResolvedValue(page('old'));
    const repository = { getParagraphPage: loader };
    const runtime = { mode: 'remote', apiBaseUrl: '/api', readerRepository: repository } as unknown as ReaderRuntime;
    let auth!: ReturnType<typeof useOptionalSelfHostAuth>;
    function Probe() {
      auth = useOptionalSelfHostAuth();
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <SelfHostAccountGate runtime={runtime}>
          <Probe />
        </SelfHostAccountGate>,
      );
    });
    try {
      await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      loader.mockImplementationOnce(
        () =>
          new Promise<ParagraphPage>((resolve) => {
            resolveOld = resolve;
          }),
      );
      const oldPending = loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 1);
      const rejectedOld = expect(oldPending).rejects.toThrow('Reader session changed');
      await act(async () => {
        if (boundary === 'logout') await auth!.logout();
        else {
          // An expired cookie: the gate re-checks and the server reports nobody signed in.
          status.mockResolvedValueOnce({
            authenticated: false,
            setupRequired: false,
            legacyRecoveryEnabled: false,
            setupCodeRequired: false,
          });
          dispatchEvent(new Event(SELF_HOST_AUTH_REQUIRED_EVENT));
        }
      });
      await act(async () => {
        await import('../../ui-next/auth/UiNextAuthScreen');
      });
      loader.mockResolvedValue(page('new'));
      // A load during the login screen must also be discarded when login succeeds.
      await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      loader.mockResolvedValue(page('reauthenticated'));
      await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      const fresh = await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
      expect(fresh?.paragraphs[0].text).toBe('reauthenticated');
      resolveOld(page('late old'));
      await rejectedOld;
      expect(
        (await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 1))?.paragraphs[0]
          .text,
      ).toBe('reauthenticated');
      expect(await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0)).toBe(fresh);
      expect(loader).toHaveBeenCalledTimes(5);
    } finally {
      await act(async () => renderer.unmount());
    }
    const stable = await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0);
    dispatchEvent(new Event(SELF_HOST_AUTH_ENDING_EVENT));
    expect(await loadSharedParagraphPage(runtime.readerRepository, 'same-revision', 'same-chapter', 0)).toBe(stable);
    expect(loader).toHaveBeenCalledTimes(5); // Gate removed both auth listeners.
  },
);

it('constructs the authenticated subtree only after status and ignores a late prior epoch failure', async () => {
  const events = new EventTarget();
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
  let resolve!: (value: Awaited<ReturnType<SelfHostAuthClient['status']>>) => void;
  const account = { userId: 'a', username: 'a', displayName: 'A', role: 'member' as const };
  const context = {
    account,
    serverId: 'server',
    libraryId: 'library',
    accountId: 'plugin',
    sessionContext: 'context',
    capabilities: {
      manageServer: false,
      manageExtensions: false,
      useSources: true,
      useProviders: false,
      exportLibrary: true,
      restoreLibrary: false,
      manageAccounts: false,
    },
    legacyDataOwner: false,
  };
  vi.spyOn(SelfHostAuthClient.prototype, 'status').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const children = vi.fn((_session: import('./self-host-session').SelfHostSession) => <span>private</span>);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SelfHostAccountGate apiBaseUrl="/api">{children}</SelfHostAccountGate>);
  });
  expect(children).not.toHaveBeenCalled();
  await act(async () =>
    resolve({
      ...context,
      authenticated: true,
      setupRequired: false,
      legacyRecoveryEnabled: false,
      setupCodeRequired: false,
    }),
  );
  expect(children).toHaveBeenCalledTimes(1);
  const session = children.mock.calls[0][0];
  await act(async () => {
    dispatchEvent(new CustomEvent(SELF_HOST_AUTH_REQUIRED_EVENT, { detail: { epoch: 'previous-runtime' } }));
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('private');
  expect(session.signal.aborted).toBe(false);
  await act(async () => {
    dispatchEvent(new CustomEvent(SELF_HOST_AUTH_REQUIRED_EVENT, { detail: { epoch: session.epoch } }));
  });
  expect(session.signal.aborted).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private');
  await act(async () => renderer.unmount());
});

function stubBrowser() {
  const events = new EventTarget();
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  vi.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', title: 'Book title' });
  vi.stubGlobal('document', doc);
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  vi.stubGlobal('sessionStorage', storage);
  return { events, doc, store };
}

const capabilities = {
  manageServer: false,
  manageExtensions: false,
  useSources: true,
  useProviders: false,
  exportLibrary: true,
  restoreLibrary: false,
  manageAccounts: false,
};
function signedIn(userId: string, sessionContext: string) {
  const account = { userId, username: userId, displayName: userId.toUpperCase(), role: 'member' as const };
  return {
    context: {
      account,
      serverId: 'server',
      libraryId: `library-${userId}`,
      accountId: `plugin-${userId}`,
      sessionContext,
      capabilities,
      legacyDataOwner: false,
    },
    authenticated: true,
    account,
    setupRequired: false,
    legacyRecoveryEnabled: false,
    setupCodeRequired: false,
  };
}

it('keeps the running app, its drafts and playback when a focus or quick return finds the same session', async () => {
  const { events, doc } = stubBrowser();
  const status = vi.spyOn(SelfHostAuthClient.prototype, 'status').mockResolvedValue(signedIn('a', 'context-a'));
  const mounts = vi.fn();
  const sessions: import('./self-host-session').SelfHostSession[] = [];
  let setDraft!: (value: string) => void;
  let draft = '';
  function PrivateApp({ session }: { session: import('./self-host-session').SelfHostSession }) {
    const [value, setValue] = useState('');
    setDraft = setValue;
    draft = value;
    useEffect(() => {
      mounts(session);
    }, [session]);
    return <span>private</span>;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SelfHostAccountGate apiBaseUrl="/api">
        {(session) => {
          if (!sessions.includes(session)) sessions.push(session);
          return <PrivateApp key={session.epoch} session={session} />;
        }}
      </SelfHostAccountGate>,
    );
  });
  try {
    expect(mounts).toHaveBeenCalledTimes(1);
    const first = sessions[0];
    await act(async () => setDraft('half-typed note'));
    // A file picker, an app switch or background audio: hidden briefly, then focus comes back.
    await act(async () => {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    });
    expect(first.signal.aborted).toBe(false);
    await act(async () => {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
      events.dispatchEvent(new Event('focus'));
    });
    expect(status.mock.calls.length).toBeGreaterThan(1);
    expect(sessions).toEqual([first]);
    expect(first.signal.aborted).toBe(false);
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(draft).toBe('half-typed note');
    expect(JSON.stringify(renderer.toJSON())).toContain('private');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('un-auth-lock');

    // A rotated session (password change, another tab signing in) does replace the runtime.
    status.mockResolvedValue(signedIn('a', 'context-a2'));
    await act(async () => {
      events.dispatchEvent(new Event('focus'));
    });
    expect(first.signal.aborted).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].context.sessionContext).toBe('context-a2');
    expect(mounts).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => renderer.unmount());
  }
});

it('a failed sign-out stays bound to its own session: B signed in later is left alone, A is retried', async () => {
  const { store } = stubBrowser();
  const status = vi.spyOn(SelfHostAuthClient.prototype, 'status').mockResolvedValue(signedIn('a', 'context-a'));
  const logout = vi.spyOn(SelfHostAuthClient.prototype, 'logout').mockRejectedValueOnce(new TypeError('offline'));
  let auth!: ReturnType<typeof useOptionalSelfHostAuth>;
  function Probe() {
    auth = useOptionalSelfHostAuth();
    return <span>private</span>;
  }
  const mount = async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <SelfHostAccountGate apiBaseUrl="/api">{(session) => <Probe key={session.epoch} />}</SelfHostAccountGate>,
      );
    });
    await act(async () => {
      await import('../../ui-next/auth/UiNextAccountTokenScreen');
    });
    return renderer;
  };

  let renderer = await mount();
  await act(async () => {
    await auth!.logout().catch(() => undefined);
  });
  expect(logout).toHaveBeenCalledWith('context-a');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private');
  expect(JSON.stringify(renderer.toJSON())).toContain('로그아웃 다시 시도');
  expect(JSON.parse(store.get('boaa.logout-pending:/api')!)).toEqual({
    serverId: 'server',
    userId: 'a',
    sessionContext: 'context-a',
  });
  await act(async () => renderer.unmount());

  // Reloading while the server still has A: the app stays closed and only A's session is retried.
  renderer = await mount();
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private');
  expect(JSON.stringify(renderer.toJSON())).toContain('로그아웃 다시 시도');
  await act(async () => renderer.unmount());

  // Meanwhile B signed in from another tab. Reloading this tab must open B, not sign B out.
  status.mockResolvedValue(signedIn('b', 'context-b'));
  renderer = await mount();
  try {
    expect(JSON.stringify(renderer.toJSON())).toContain('private');
    expect(auth?.session?.context.account.userId).toBe('b');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(store.has('boaa.logout-pending:/api')).toBe(false);
  } finally {
    await act(async () => renderer.unmount());
  }
});

it('keeps an invitation link through StrictMode and remounts after stripping it from the address', async () => {
  stubBrowser();
  resetAccountLinkForTests();
  const replaceState = vi.fn();
  vi.stubGlobal('location', { href: 'http://localhost/#invitation=synthetic-token' });
  vi.stubGlobal('history', { replaceState });
  vi.spyOn(SelfHostAuthClient.prototype, 'status').mockResolvedValue({
    authenticated: false,
    setupRequired: false,
    legacyRecoveryEnabled: false,
    setupCodeRequired: false,
  });
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true, username: 'cousin', displayName: 'Cousin' }), { status: 200 }),
    );
  vi.stubGlobal('fetch', fetch);
  const tree = () => (
    <StrictMode>
      <SelfHostAccountGate apiBaseUrl="/api">{() => <span>private</span>}</SelfHostAccountGate>
    </StrictMode>
  );
  let renderer!: ReactTestRenderer;
  const settle = async () => {
    await act(async () => {
      await import('../../ui-next/auth/UiNextAccountTokenScreen');
      await import('../../ui-next/auth/UiNextAuthScreen');
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  try {
    await act(async () => {
      renderer = create(tree());
    });
    await settle();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(JSON.stringify(renderer.toJSON())).toContain('BOAA에 초대받았어요');
    await act(async () => renderer.unmount());

    // A remount on the same page (address already clean) still offers the same link.
    await act(async () => {
      renderer = create(tree());
    });
    await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('BOAA에 초대받았어요');
    const [password, confirmation] = renderer.root.findAll(
      (node) => node.type === 'input' && node.props.autoComplete === 'new-password',
    );
    await act(async () => password.props.onChange({ target: { value: 'synthetic-pass-1' } }));
    await act(async () => confirmation.props.onChange({ target: { value: 'synthetic-pass-1' } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    await settle();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'synthetic-token', password: 'synthetic-pass-1' });
    expect(JSON.stringify(renderer.toJSON())).toContain('이제 로그인해 주세요');
    await act(async () => renderer.unmount());

    // Once used, the token is gone from memory too.
    await act(async () => {
      renderer = create(tree());
    });
    await settle();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('BOAA에 초대받았어요');
  } finally {
    await act(async () => renderer.unmount());
    resetAccountLinkForTests();
  }
});
