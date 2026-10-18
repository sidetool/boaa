import { StrictMode, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { SelfHostSession } from '../../../features/auth/self-host-session';
import { AccountPage } from './AccountPage';

// Sheets portal to document.body; render them inline so the flows can be driven here.
vi.mock('../../components/primitives', async (original) => ({
  ...(await original<typeof import('../../components/primitives')>()),
  Sheet: (props: { open: boolean; title?: ReactNode; children: ReactNode; footer?: ReactNode }) =>
    props.open ? (
      <div data-sheet={String(props.title)}>
        {props.children}
        {props.footer}
      </div>
    ) : null,
}));
vi.mock('../../components/dialogs', () => ({
  ConfirmSheet: (props: {
    open: boolean;
    title: string;
    confirmLabel: string;
    children?: ReactNode;
    onConfirm(): void;
    onClose(): void;
  }) =>
    props.open ? (
      <div data-sheet={props.title}>
        {props.children}
        <button type="button" onClick={() => (props.onConfirm(), props.onClose())}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
  PromptSheet: () => null,
}));

let auth: unknown;
vi.mock('../../../features/auth/SelfHostAccountGate', () => ({ useOptionalSelfHostAuth: () => auth }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth = undefined;
});

const capabilities = (admin: boolean, manageAccounts = admin) => ({
  manageAccounts,
  manageServer: admin,
  manageExtensions: admin,
  useSources: true,
  useProviders: admin,
  exportLibrary: true,
  restoreLibrary: admin,
});

function signIn(role: 'admin' | 'member', manageAccounts = role === 'admin') {
  const account = { userId: `${role}-id`, username: role, displayName: role === 'admin' ? 'Owner' : 'Reader', role };
  const session = new SelfHostSession(
    {
      account,
      serverId: 'server',
      libraryId: 'library',
      accountId: 'plugin',
      sessionContext: 'context',
      capabilities: capabilities(role === 'admin', manageAccounts),
      legacyDataOwner: role === 'admin',
    },
    '/api',
  );
  const logout = vi.fn(async () => undefined);
  const revalidate = vi.fn(async () => undefined);
  auth = { account, session, logout, revalidate };
  return { session, logout, revalidate };
}

type Route = (body: unknown) => { status?: number; body: unknown };
function serve(routes: Record<string, Route>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const result = route(init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');
const text = (renderer: ReactTestRenderer) => textOf(renderer.root);
const button = (root: ReactTestInstance, label: string) => {
  const buttons = root.findAll((node) => node.type === 'button' && textOf(node).includes(label));
  return buttons.find((node) => textOf(node).trim() === label) ?? buttons[0];
};
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const members = [
  { userId: 'admin-id', username: 'admin', displayName: 'Owner', role: 'admin', status: 'active' },
  { userId: 'm1', username: 'kid', displayName: 'Kid', role: 'member', status: 'active' },
  { userId: 'm2', username: 'aunt', displayName: 'Aunt', role: 'member', status: 'invited' },
];

it('shows a member only their own account, without the member list or admin requests', async () => {
  const { logout } = signIn('member');
  const fetch = serve({});
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AccountPage />);
  });
  expect(text(renderer)).toContain('Reader');
  expect(text(renderer)).toContain('@member');
  expect(text(renderer)).not.toContain('회원 초대');
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button(renderer.root, '로그아웃').props.onClick());
  expect(logout).toHaveBeenCalledTimes(1);
});

it('keeps account administration closed while the server has not enabled members', async () => {
  signIn('admin', false);
  const fetch = serve({});
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AccountPage />);
  });
  expect(renderer.root.findAll((node) => node.props['aria-label'] === '계정 목록')).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('invites a member and hands over a ready-to-send message with the ID, falling back when copy is blocked', async () => {
  signIn('admin');
  let invited: unknown;
  const fetch = serve({
    'GET /api/admin/accounts': () => ({ body: { accounts: members } }),
    'POST /api/admin/accounts': (body) => {
      invited = body;
      return {
        status: 201,
        body: {
          account: { userId: 'm3', username: 'cousin', displayName: 'Cousin', role: 'member', status: 'invited' },
          token: 'synthetic-token',
          expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
        },
      };
    },
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => (callback(), 0));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AccountPage />);
  });
  await flush();
  expect(text(renderer)).toContain('Kid');
  expect(text(renderer)).toContain('초대 대기');

  await act(async () => button(renderer.root, '초대').props.onClick());
  const [usernameInput, nameInput] = renderer.root
    .findByProps({ id: 'un-account-invite' })
    .findAll((node) => node.type === 'input');
  await act(async () => usernameInput.props.onChange({ target: { value: 'cousin' } }));
  await act(async () => nameInput.props.onChange({ target: { value: 'Cousin' } }));
  await act(async () => renderer.root.findByProps({ id: 'un-account-invite' }).props.onSubmit({ preventDefault() {} }));
  await flush();
  expect(invited).toEqual({ username: 'cousin', displayName: 'Cousin' });

  const sheet = renderer.root.findByProps({ 'data-sheet': '초대 링크가 준비됐어요' });
  const link = sheet.findByProps({ 'aria-label': '초대 링크' }).props.value as string;
  expect(link).toMatch(/#invitation=synthetic-token$/);
  expect(text(renderer)).toContain('로그인 아이디 cousin');
  await act(async () => button(sheet, '안내문 복사').props.onClick());
  expect(text(renderer)).toContain('자동 복사를 막았어요');
  const manual = renderer.root.findByProps({ 'aria-label': '직접 복사할 내용' }).props.value as string;
  expect(manual).toContain('아이디: cousin');
  expect(manual).toContain(link);
  // The token is only in the link field, never in any list or request after creation.
  expect(fetch.mock.calls.filter(([, init]) => String(init?.body ?? '').includes('synthetic-token'))).toHaveLength(0);
});

it('loads a member’s sources only when their row is opened, and allows an installed source', async () => {
  signIn('admin');
  let allowed: unknown;
  const fetch = serve({
    'GET /api/admin/accounts': () => ({ body: { accounts: members } }),
    'GET /api/admin/accounts/m1/sources': () => ({
      body: {
        packages: [],
        available: [{ kind: 'apk', id: 'synthetic.apk', version: '1.0', enabled: true }],
      },
    }),
    'POST /api/admin/accounts/m1/sources': (body) => {
      allowed = body;
      return { body: { changed: true, packages: [{ kind: 'apk', id: 'synthetic.apk', enabled: true }] } };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AccountPage />);
  });
  await flush();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/sources'))).toBe(false);
  await act(async () => button(renderer.root, 'Kid').props.onClick());
  await flush();
  expect(text(renderer)).toContain('synthetic.apk');
  await act(async () => renderer.root.findByProps({ 'aria-label': 'synthetic.apk 허용' }).props.onClick());
  await flush();
  expect(allowed).toEqual({ kind: 'apk', id: 'synthetic.apk' });
  expect(renderer.root.findByProps({ 'aria-label': 'synthetic.apk 허용 해제' })).toBeTruthy();
});

it('changes the password and lets the gate pick up the rotated session', async () => {
  const { revalidate } = signIn('member');
  let sent: unknown;
  serve({
    'POST /api/auth/password': (body) => {
      sent = body;
      return { body: { authenticated: true } };
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AccountPage />);
  });
  const fields = renderer.root.findAll((node) => node.type === 'input' && node.props.type === 'password');
  await act(async () => fields[0].props.onChange({ target: { value: 'old-password-1' } }));
  await act(async () => fields[1].props.onChange({ target: { value: 'new-password-1' } }));
  await act(async () => fields[2].props.onChange({ target: { value: 'new-password-1' } }));
  const form = fields[0].parent!.parent!.parent!.parent!;
  await act(async () =>
    (form.type === 'form' ? form : renderer.root.findByType('form')).props.onSubmit({ preventDefault() {} }),
  );
  await flush();
  expect(sent).toEqual({ currentPassword: 'old-password-1', newPassword: 'new-password-1' });
  expect(revalidate).toHaveBeenCalledTimes(1);
});

it('lists accounts and enables invitations under StrictMode', async () => {
  signIn('admin');
  serve({ 'GET /api/admin/accounts': () => ({ body: { accounts: members } }) });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <AccountPage />
      </StrictMode>,
    );
  });
  await flush();
  expect(text(renderer)).toContain('Kid');
  expect(button(renderer.root, '초대').props.disabled).toBe(false);
});
