import type { SelfHostAuthenticatedContext } from '@boaa/contracts';
import { useOptionalSelfHostAuth } from './SelfHostAccountGate';
import type { SelfHostSession } from './self-host-session';

export type SelfHostCapability = keyof SelfHostAuthenticatedContext['capabilities'];

/**
 * What the signed-in self-host account may manage. Outside a self-host account session (local library,
 * desktop, older servers without capabilities) nothing is restricted. The server stays authoritative; this
 * only decides what the UI offers.
 */
export function useSelfHostCapability(capability: SelfHostCapability): boolean {
  const capabilities = useOptionalSelfHostAuth()?.session?.context.capabilities;
  return capabilities ? capabilities[capability] === true : true;
}

export type ManagedAccountStatus = 'active' | 'invited' | 'disabled';

export interface ManagedAccount {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'admin' | 'member';
  readonly status: ManagedAccountStatus;
  readonly createdAt?: string;
}

/** One-time link material. Lives only in component memory until the administrator closes it. */
export interface AccountLinkGrant {
  readonly token: string;
  readonly expiresAt: string;
}

export interface MemberSource {
  readonly kind: 'package' | 'apk' | 'mangayomi';
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly enabled: boolean;
}

export class AccountRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'AccountRequestError';
  }
}

async function request<T>(session: SelfHostSession, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await session.fetch(`${session.apiBaseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok)
    throw new AccountRequestError(typeof data.error === 'string' ? data.error : 'request_failed', response.status);
  return data as T;
}

const account = (userId: string) => `/admin/accounts/${encodeURIComponent(userId)}`;

export const accountApi = {
  list: (session: SelfHostSession) =>
    request<{ accounts: ManagedAccount[] }>(session, '/admin/accounts').then((data) => data.accounts ?? []),
  invite: (session: SelfHostSession, input: { username: string; displayName?: string }) =>
    request<AccountLinkGrant & { account: ManagedAccount }>(session, '/admin/accounts', 'POST', input),
  reissueInvitation: (session: SelfHostSession, userId: string) =>
    request<AccountLinkGrant>(session, `${account(userId)}/invitation`, 'POST'),
  passwordReset: (session: SelfHostSession, userId: string) =>
    request<AccountLinkGrant>(session, `${account(userId)}/password-reset`, 'POST'),
  update: (session: SelfHostSession, userId: string, input: { displayName?: string; enabled?: boolean }) =>
    request<{ ok: true }>(session, account(userId), 'PATCH', input),
  revokeSessions: (session: SelfHostSession, userId: string) =>
    request<{ ok: true }>(session, `${account(userId)}/sessions`, 'DELETE'),
  /** Opens the member's source runtime on the server, so call it only when the administrator asks to see it. */
  sources: (session: SelfHostSession, userId: string) =>
    request<{ packages: MemberSource[]; available: MemberSource[] }>(session, `${account(userId)}/sources`),
  allowSource: (session: SelfHostSession, userId: string, source: Pick<MemberSource, 'kind' | 'id'>) =>
    request<{ packages: MemberSource[] }>(session, `${account(userId)}/sources`, 'POST', {
      kind: source.kind,
      id: source.id,
    }),
  removeSource: (session: SelfHostSession, userId: string, source: Pick<MemberSource, 'kind' | 'id'>) =>
    request<{ packages: MemberSource[] }>(session, `${account(userId)}/sources`, 'DELETE', {
      kind: source.kind,
      id: source.id,
    }),
  changePassword: (session: SelfHostSession, currentPassword: string, newPassword: string) =>
    request<unknown>(session, '/auth/password', 'POST', { currentPassword, newPassword }),
};

/** The address a recipient opens. The token rides in the fragment, which the gate strips before anything loads. */
export function accountLinkUrl(kind: 'invitation' | 'password-reset', token: string): string {
  const url = new URL(import.meta.env?.BASE_URL || '/', globalThis.location?.origin ?? 'http://localhost');
  url.hash = `${kind}=${encodeURIComponent(token)}`;
  return url.href;
}

/** True when the request ended because the session itself ended; the gate already shows what happens next. */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function accountErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return '서버에 연결하지 못했어요. 연결을 확인하고 다시 해 주세요.';
  if (!(error instanceof AccountRequestError)) return '요청을 처리하지 못했어요. 잠시 뒤 다시 해 주세요.';
  switch (error.code) {
    case 'username_unavailable':
      return '이미 쓰고 있는 아이디예요. 다른 아이디를 정해 주세요.';
    case 'invalid_username':
      return '아이디는 2~64자의 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)으로 정해 주세요.';
    case 'invalid_display_name':
      return '표시 이름은 80자 이내로 적어 주세요.';
    case 'members_not_ready':
      return '이 서버는 아직 회원을 초대할 수 없어요. 서버를 업데이트해 주세요.';
    case 'account_not_found':
      return '그 사이 계정 상태가 바뀌었어요. 목록을 다시 불러왔어요.';
    case 'protected_account':
      return '서버를 처음 만든 관리자 계정은 이용을 중지할 수 없어요.';
    case 'source_binding_exists':
      return '이미 허용한 소스예요. 목록을 다시 불러왔어요.';
    case 'source_binding_missing':
      return '관리자 쪽에서 이 소스가 제거됐어요. 목록을 다시 불러왔어요.';
    case 'source_runtime_unavailable':
      return '이 형식의 소스를 실행할 구성요소가 서버에 없어요. 서버 관리에서 확인해 주세요.';
    case 'invalid_credentials':
      return '현재 비밀번호가 맞지 않아요.';
    case 'invalid_password':
      return '새 비밀번호는 10자 이상 256자 이하로 정해 주세요.';
    case 'login_rate_limited':
      return '시도가 너무 많았어요. 5분 뒤에 다시 해 주세요.';
    default:
      if (error.status === 403) return '이 작업은 서버 관리자만 할 수 있어요.';
      if (error.status === 404) return '이 서버는 아직 계정 관리를 지원하지 않아요. 서버를 업데이트해 주세요.';
      return '요청을 처리하지 못했어요. 잠시 뒤 다시 해 주세요.';
  }
}
