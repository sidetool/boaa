import { Check, ChevronDown, Copy, KeyRound, LogOut, MonitorX, Plus, RefreshCw, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useOptionalSelfHostAuth } from '../../../features/auth/SelfHostAccountGate';
import {
  accountApi,
  accountErrorMessage,
  accountLinkUrl,
  isSessionEnded,
  type AccountLinkGrant,
  type ManagedAccount,
  type MemberSource,
} from '../../../features/auth/self-host-account-api';
import type { SelfHostSession } from '../../../features/auth/self-host-session';
import { ConfirmSheet, PromptSheet } from '../../components/dialogs';
import {
  EmptyState,
  Notice,
  Pref,
  PrefField,
  PrefFold,
  PrefGroup,
  PrefSection,
  PrefSkeleton,
} from '../../components/prefs';
import { cx, Sheet } from '../../components/primitives';
import './account.css';

const ROLE_LABEL = { admin: '관리자', member: '회원' } as const;
const STATUS_LABEL = { active: '사용 중', invited: '초대 대기', disabled: '이용 중지' } as const;
const SOURCE_KIND_LABEL = { package: 'BOAA 확장', apk: 'APK', mangayomi: 'Mangayomi' } as const;

function expiryText(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  const hours = Math.round((date.getTime() - Date.now()) / 3_600_000);
  const at = date.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return hours >= 2 ? `${at}까지 (${hours}시간)` : `${at}까지`;
}

function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  return (
    <span className={cx('un-account-avatar', muted && 'is-muted')} aria-hidden="true">
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

type LinkResult = { kind: 'invitation' | 'password-reset'; name: string; username: string } & AccountLinkGrant;

/** The one moment a link can be seen: copy it here or make a new one later (which voids this one). */
function LinkSheet({ result, onClose }: { result?: LinkResult; onClose(): void }) {
  const manualField = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<'message' | 'link'>();
  const [manual, setManual] = useState<string>();
  useEffect(() => {
    setCopied(undefined);
    setManual(undefined);
  }, [result?.token]);
  useEffect(() => {
    if (manual === undefined) return;
    manualField.current?.focus();
    manualField.current?.select();
  }, [manual]);
  if (!result) return null;
  const url = accountLinkUrl(result.kind, result.token);
  const invitation = result.kind === 'invitation';
  const until = expiryText(result.expiresAt);
  // Who gets the link also needs the ID they will sign in with; send both in one message.
  const message = invitation
    ? `BOAA 서재에 초대했어요.\n아이디: ${result.username}\n아래 링크에서 비밀번호를 정한 뒤 이 아이디로 로그인하세요. (${until}, 한 번만 쓸 수 있어요)\n${url}`
    : `BOAA 비밀번호 재설정 링크예요.\n아이디: ${result.username}\n아래 링크에서 새 비밀번호를 정한 뒤 로그인하세요. (${until}, 한 번만 쓸 수 있어요)\n${url}`;
  const copy = async (what: 'message' | 'link') => {
    const value = what === 'message' ? message : url;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setManual(undefined);
    } catch {
      setCopied(undefined);
      setManual(value);
    }
  };
  return (
    <Sheet
      open
      variant="dialog"
      onClose={onClose}
      title={invitation ? '초대 링크가 준비됐어요' : '비밀번호 재설정 링크'}
      footer={
        <>
          <button type="button" className="un-btn is-ghost" onClick={onClose}>
            {copied ? '다 했어요' : '닫기'}
          </button>
          <button type="button" className="un-btn is-primary" onClick={() => void copy('message')}>
            {copied === 'message' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied === 'message' ? '안내문 복사됨' : '안내문 복사'}
          </button>
        </>
      }
    >
      <div className="un-dialog-body un-account-link">
        <div className="un-account-link-who">
          <Avatar name={result.name} />
          <span>
            <b>{result.name}</b>
            <small>
              로그인 아이디 <code>{result.username}</code>
            </small>
          </span>
        </div>
        <p>
          {invitation
            ? '안내문에는 아이디와 링크가 함께 들어 있어요. 메신저로 직접 보내 주세요. 링크에서 비밀번호를 정하면 초대가 끝나요.'
            : '안내문을 직접 보내 주세요. 새 비밀번호를 정하면 그 계정은 모든 기기에서 로그아웃돼요.'}
        </p>
        <div className="un-account-link-row">
          <input
            className="un-input"
            aria-label={invitation ? '초대 링크' : '비밀번호 재설정 링크'}
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => void copy('link')}>
            {copied === 'link' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied === 'link' ? '복사됨' : '링크만'}
          </button>
        </div>
        {manual !== undefined && (
          <textarea
            ref={manualField}
            className="un-input un-account-link-manual"
            aria-label="직접 복사할 내용"
            readOnly
            rows={manual === url ? 2 : 5}
            value={manual}
          />
        )}
        <small role="status" className={cx('un-account-link-hint', manual !== undefined && 'is-warning')}>
          {manual !== undefined
            ? '이 브라우저가 자동 복사를 막았어요. 위에 선택해 둔 내용을 길게 누르거나 Ctrl+C로 복사해 주세요.'
            : copied
              ? '복사했어요. 받는 사람에게 보낸 뒤 닫아 주세요.'
              : `${until} 열려요. 이 창을 닫으면 링크를 다시 볼 수 없고, 새로 만들면 이 링크는 못 쓰게 돼요.`}
        </small>
      </div>
    </Sheet>
  );
}

function InviteSheet({
  open,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  error?: string;
  onSubmit(input: { username: string; displayName: string }): void;
  onClose(): void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setUsername('');
    setDisplayName('');
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!busy && username.trim()) onSubmit({ username: username.trim(), displayName: displayName.trim() });
  };
  return (
    <Sheet
      open={open}
      variant="dialog"
      onClose={onClose}
      closeDisabled={busy}
      title="회원 초대"
      footer={
        <>
          <button type="button" className="un-btn is-ghost" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            type="submit"
            form="un-account-invite"
            className="un-btn is-primary"
            disabled={busy || !username.trim()}
          >
            {busy ? <RefreshCw size={16} className="un-account-spin" aria-hidden="true" /> : <UserPlus size={16} />}
            {busy ? '만드는 중…' : '초대 링크 만들기'}
          </button>
        </>
      }
    >
      <form id="un-account-invite" className="un-dialog-body un-account-form" onSubmit={submit}>
        <PrefField label="아이디" help="로그인할 때 쓰고, 나중에 바꿀 수 없어요. 영문·숫자·. _ - 로 2~64자.">
          <input
            ref={first}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={2}
            maxLength={64}
            required
            disabled={busy}
          />
        </PrefField>
        <PrefField label="표시 이름 (선택)" help="앱에 보이는 이름이에요. 비워 두면 아이디를 써요.">
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="off"
            maxLength={80}
            disabled={busy}
          />
        </PrefField>
        {error && <Notice tone="danger">{error}</Notice>}
        <small className="un-account-form-note">
          새 회원의 서재와 소스는 비어 있는 상태로 시작해요. 쓸 소스는 초대한 뒤 허용할 수 있어요.
        </small>
      </form>
    </Sheet>
  );
}

function PasswordChange({ session, onChanged }: { session: SelfHostSession; onChanged(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mismatch = confirm.length > 0 && next !== confirm;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (next !== confirm) return setError('새 비밀번호 두 칸이 달라요.');
    if (next === current) return setError('지금 비밀번호와 다른 비밀번호로 정해 주세요.');
    setBusy(true);
    setError(undefined);
    try {
      await accountApi.changePassword(session, current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      // The server issued a new session; the gate rebuilds the app around it.
      onChanged();
    } catch (failure) {
      if (isSessionEnded(failure)) return;
      setError(accountErrorMessage(failure));
      setBusy(false);
    }
  };
  return (
    <PrefFold title="비밀번호 바꾸기" summary="바꾸면 다른 기기는 모두 로그아웃돼요">
      <form className="un-account-form is-inline" onSubmit={(event) => void submit(event)}>
        {/* Lets password managers file the new password under this account. */}
        <input type="text" autoComplete="username" value={session.context.account.username} readOnly hidden />
        <PrefField label="지금 비밀번호">
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
            disabled={busy}
          />
        </PrefField>
        <PrefField label="새 비밀번호" help="10자 이상">
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            minLength={10}
            maxLength={256}
            required
            disabled={busy}
          />
        </PrefField>
        <PrefField label="새 비밀번호 확인" error={mismatch ? '두 칸이 달라요.' : undefined}>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            minLength={10}
            maxLength={256}
            required
            disabled={busy}
          />
        </PrefField>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="un-account-form-actions">
          <button type="submit" className="un-btn is-primary is-sm" disabled={busy || mismatch}>
            {busy ? <RefreshCw size={15} className="un-account-spin" aria-hidden="true" /> : <KeyRound size={15} />}
            {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
          </button>
        </div>
      </form>
    </PrefFold>
  );
}

/** Sources this member may use. Loaded only on demand: reading it wakes the member's source runtime. */
function MemberSources({ session, member }: { session: SelfHostSession; member: ManagedAccount }) {
  const [state, setState] = useState<{ packages: MemberSource[]; available: MemberSource[] }>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<MemberSource>();
  const key = (source: Pick<MemberSource, 'kind' | 'id'>) => `${source.kind}:${source.id}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setState(await accountApi.sources(session, member.userId));
    } catch (failure) {
      if (!isSessionEnded(failure)) setError(accountErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [session, member.userId]);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (source: MemberSource, allow: boolean) => {
    setPending(key(source));
    setError(undefined);
    try {
      const result = allow
        ? await accountApi.allowSource(session, member.userId, source)
        : await accountApi.removeSource(session, member.userId, source);
      setState((previous) => previous && { ...previous, packages: result.packages });
    } catch (failure) {
      if (isSessionEnded(failure)) return;
      setError(accountErrorMessage(failure));
      void load();
    } finally {
      setPending(undefined);
    }
  };

  if (!state && loading) return <PrefSkeleton rows={2} />;
  if (!state)
    return (
      <Notice
        tone="danger"
        action={
          <button type="button" className="un-btn is-text is-sm" onClick={() => void load()}>
            다시 시도
          </button>
        }
      >
        {error ?? '소스 목록을 불러오지 못했어요.'}
      </Notice>
    );

  const allowed = new Set(state.packages.map(key));
  const sources = [
    ...state.available,
    // A member may still hold a source the administrator has since removed; keep it removable.
    ...state.packages.filter((source) => !state.available.some((entry) => key(entry) === key(source))),
  ];
  return (
    <div className="un-account-sources">
      {sources.length === 0 ? (
        <p className="un-account-muted">
          서버에 설치한 소스가 없어요. 콘텐츠 소스에서 확장을 설치하면 여기서 회원에게 허용할 수 있어요.
        </p>
      ) : (
        <ul aria-label={`${member.displayName}님이 쓸 수 있는 소스`}>
          {sources.map((source) => {
            const on = allowed.has(key(source));
            const orphan = !state.available.some((entry) => key(entry) === key(source));
            const busy = pending === key(source);
            const name = source.name || source.id;
            return (
              <li key={key(source)} className={cx(on && 'is-on')}>
                <span className="un-account-source-text">
                  <b>{name}</b>
                  <small>
                    {SOURCE_KIND_LABEL[source.kind]}
                    {source.version ? ` · ${source.version}` : ''}
                    {orphan ? ' · 관리자 쪽에서 제거됨' : ''}
                  </small>
                </span>
                <button
                  type="button"
                  className={cx('un-btn is-sm', on ? 'is-ghost' : 'is-primary')}
                  disabled={Boolean(pending)}
                  aria-label={on ? `${name} 허용 해제` : `${name} 허용`}
                  onClick={() => (on ? setConfirmRemove(source) : void change(source, true))}
                >
                  {busy ? (
                    <RefreshCw size={14} className="un-account-spin" aria-hidden="true" />
                  ) : on ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Plus size={14} aria-hidden="true" />
                  )}
                  {on ? '허용됨' : '허용'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <small className="un-account-muted">
        허용하면 설치한 코드만 넘어가요. 내 로그인과 설정은 복사되지 않고, 회원이 직접 로그인해요.
      </small>
      <ConfirmSheet
        open={Boolean(confirmRemove)}
        title="소스 허용을 해제할까요?"
        confirmLabel="해제"
        danger
        onConfirm={() => confirmRemove && void change(confirmRemove, false)}
        onClose={() => setConfirmRemove(undefined)}
      >
        <p>
          {member.displayName}님은 {confirmRemove?.name || confirmRemove?.id}을(를) 더 쓸 수 없고, 그 소스에 저장한
          로그인과 설정도 함께 지워져요. 받아 둔 작품은 서재에 남아요.
        </p>
      </ConfirmSheet>
    </div>
  );
}

type Confirm = { kind: 'disable' | 'enable' | 'sessions' | 'reset'; account: ManagedAccount };

function AccountRow({
  account,
  self,
  open,
  busy,
  session,
  onToggle,
  onAction,
}: {
  account: ManagedAccount;
  self: boolean;
  open: boolean;
  busy: boolean;
  session: SelfHostSession;
  onToggle(): void;
  onAction(action: 'reissue' | 'rename' | Confirm['kind']): void;
}) {
  const disabled = account.status === 'disabled';
  const actions: {
    id: Parameters<typeof onAction>[0];
    label: string;
    help: string;
    icon: ReactNode;
    danger?: boolean;
  }[] = [];
  if (account.status === 'invited')
    actions.push({
      id: 'reissue',
      label: '초대 링크 다시 만들기',
      help: '링크를 잃어버렸을 때 써요. 전에 보낸 링크는 바로 못 쓰게 돼요.',
      icon: <RefreshCw size={15} />,
    });
  if (account.status === 'active' && !self)
    actions.push(
      {
        id: 'reset',
        label: '비밀번호 재설정 링크',
        help: '비밀번호를 잊었을 때 써요. 1시간 동안 열려요.',
        icon: <KeyRound size={15} />,
      },
      {
        id: 'sessions',
        label: '모든 기기에서 로그아웃',
        help: '비밀번호는 그대로 두고 지금 로그인된 곳만 끝내요.',
        icon: <MonitorX size={15} />,
      },
    );
  actions.push({ id: 'rename', label: '표시 이름 바꾸기', help: '아이디는 그대로예요.', icon: <UserPlus size={15} /> });
  if (!self && account.role === 'member')
    actions.push(
      disabled
        ? {
            id: 'enable',
            label: '다시 이용하게 하기',
            help: '서재와 설정은 중지 전 그대로예요.',
            icon: <Check size={15} />,
          }
        : {
            id: 'disable',
            label: '이용 중지',
            help: '바로 로그아웃되고 로그인할 수 없어요. 서재는 지우지 않아요.',
            icon: <LogOut size={15} />,
            danger: true,
          },
    );

  return (
    <li className={cx('un-account-row', open && 'is-open', disabled && 'is-disabled')}>
      <button
        type="button"
        className="un-account-row-main"
        aria-expanded={open}
        aria-controls={`un-account-${account.userId}`}
        onClick={onToggle}
      >
        <Avatar name={account.displayName || account.username} muted={disabled} />
        <span className="un-account-row-text">
          <b>
            {account.displayName}
            {self && <em className="un-account-me">나</em>}
          </b>
          <small>
            @{account.username} · {ROLE_LABEL[account.role]}
          </small>
        </span>
        {account.status !== 'active' && (
          <span className={cx('un-account-status', `is-${account.status}`)}>{STATUS_LABEL[account.status]}</span>
        )}
        <ChevronDown size={18} className="un-account-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={`un-account-${account.userId}`} className="un-account-row-body">
          <div className="un-account-actions">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={cx('un-account-action', action.danger && 'is-danger')}
                disabled={busy}
                onClick={() => onAction(action.id)}
              >
                {action.icon}
                <span>
                  <b>{action.label}</b>
                  <small>{action.help}</small>
                </span>
              </button>
            ))}
          </div>
          {account.role === 'member' && !disabled && (
            <section className="un-account-sources-block" aria-label="허용한 소스">
              <h4>쓸 수 있는 소스</h4>
              <MemberSources session={session} member={account} />
            </section>
          )}
        </div>
      )}
    </li>
  );
}

function Members({ session, selfId }: { session: SelfHostSession; selfId: string }) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>();
  const [loadError, setLoadError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string>();
  const [link, setLink] = useState<LinkResult>();
  const [confirm, setConfirm] = useState<Confirm>();
  const [renaming, setRenaming] = useState<ManagedAccount>();
  const alive = useRef(true);
  // StrictMode runs setup, cleanup, setup: restore on every setup so responses are not dropped.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await accountApi.list(session);
      if (!alive.current) return;
      setAccounts(next);
      setLoadError(undefined);
    } catch (failure) {
      if (alive.current && !isSessionEnded(failure)) setLoadError(accountErrorMessage(failure));
    }
  }, [session]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (task: () => Promise<string | void>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const text = await task();
      if (text && alive.current) setNotice({ tone: 'info', text });
    } catch (failure) {
      if (isSessionEnded(failure) || !alive.current) return;
      setNotice({ tone: 'danger', text: accountErrorMessage(failure) });
      void refresh();
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const invite = async (input: { username: string; displayName: string }) => {
    setBusy(true);
    setInviteError(undefined);
    try {
      const grant = await accountApi.invite(session, {
        username: input.username,
        displayName: input.displayName || undefined,
      });
      if (!alive.current) return;
      setInviting(false);
      setLink({
        kind: 'invitation',
        token: grant.token,
        expiresAt: grant.expiresAt,
        name: grant.account.displayName,
        username: grant.account.username,
      });
      setOpen(grant.account.userId);
      void refresh();
    } catch (failure) {
      if (!isSessionEnded(failure) && alive.current) setInviteError(accountErrorMessage(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const act = (account: ManagedAccount, action: 'reissue' | 'rename' | Confirm['kind']) => {
    if (action === 'rename') return setRenaming(account);
    if (action !== 'reissue') return setConfirm({ kind: action, account });
    void run(async () => {
      const grant = await accountApi.reissueInvitation(session, account.userId);
      setLink({ kind: 'invitation', ...grant, name: account.displayName, username: account.username });
    });
  };

  const confirmed = (item: Confirm) =>
    void run(async () => {
      const { account } = item;
      if (item.kind === 'reset') {
        const grant = await accountApi.passwordReset(session, account.userId);
        setLink({ kind: 'password-reset', ...grant, name: account.displayName, username: account.username });
        return;
      }
      if (item.kind === 'sessions') {
        await accountApi.revokeSessions(session, account.userId);
        return `${account.displayName}님의 모든 기기에서 로그아웃했어요.`;
      }
      await accountApi.update(session, account.userId, { enabled: item.kind === 'enable' });
      await refresh();
      return item.kind === 'enable'
        ? `${account.displayName}님이 다시 이용할 수 있어요.`
        : `${account.displayName}님의 이용을 중지했어요.`;
    });

  const confirmCopy: Record<Confirm['kind'], { title: string; label: string; body: string; danger?: boolean }> = {
    disable: {
      title: '이용을 중지할까요?',
      label: '이용 중지',
      body: '모든 기기에서 바로 로그아웃되고, 보내 둔 초대·재설정 링크도 못 쓰게 돼요. 서재와 기록은 지우지 않으며 언제든 다시 이용하게 할 수 있어요.',
      danger: true,
    },
    enable: {
      title: '다시 이용하게 할까요?',
      label: '다시 이용하게 하기',
      body: '중지 전 서재와 설정 그대로 로그인할 수 있어요. 초대를 받지 않은 계정이면 새 초대 링크가 필요해요.',
    },
    sessions: {
      title: '모든 기기에서 로그아웃할까요?',
      label: '로그아웃시키기',
      body: '비밀번호는 바뀌지 않아요. 다시 로그인하면 이어서 쓸 수 있어요.',
    },
    reset: {
      title: '비밀번호 재설정 링크를 만들까요?',
      label: '링크 만들기',
      body: '링크는 1시간 동안 열려요. 그 전에 쓰던 비밀번호는 링크로 새 비밀번호를 정할 때까지 그대로 쓸 수 있어요.',
    },
  };

  const sorted = accounts && [
    ...accounts.filter((account) => account.userId === selfId),
    ...accounts.filter((account) => account.userId !== selfId),
  ];

  return (
    <PrefSection
      title="회원"
      hint="관리자도 회원의 서재, 독서 기록, 소스 로그인은 볼 수 없어요."
      action={
        <button
          type="button"
          className="un-btn is-primary is-sm"
          disabled={busy || !accounts}
          onClick={() => {
            setInviteError(undefined);
            setInviting(true);
          }}
        >
          <UserPlus size={15} />
          초대
        </button>
      }
    >
      {notice && (
        <Notice tone={notice.tone}>
          <span role={notice.tone === 'info' ? 'status' : undefined}>{notice.text}</span>
        </Notice>
      )}
      {!accounts && !loadError && <PrefSkeleton rows={2} />}
      {!accounts && loadError && (
        <Notice
          tone="danger"
          action={
            <button type="button" className="un-btn is-text is-sm" onClick={() => void refresh()}>
              다시 시도
            </button>
          }
        >
          {loadError}
        </Notice>
      )}
      {sorted && (
        <ul className="un-account-list" aria-label="계정 목록">
          {sorted.map((account) => (
            <AccountRow
              key={account.userId}
              account={account}
              self={account.userId === selfId}
              open={open === account.userId}
              busy={busy}
              session={session}
              onToggle={() => setOpen(open === account.userId ? undefined : account.userId)}
              onAction={(action) => act(account, action)}
            />
          ))}
        </ul>
      )}
      {sorted && sorted.length <= 1 && (
        <EmptyState
          icon={<UserPlus size={22} />}
          title="아직 초대한 회원이 없어요"
          body="가족이나 지인의 아이디를 정하고, 만들어진 링크를 직접 전해 주세요."
        />
      )}

      <InviteSheet
        open={inviting}
        busy={busy}
        error={inviteError}
        onSubmit={(input) => void invite(input)}
        onClose={() => setInviting(false)}
      />
      <LinkSheet result={link} onClose={() => setLink(undefined)} />
      <ConfirmSheet
        open={Boolean(confirm)}
        title={confirm ? confirmCopy[confirm.kind].title : ''}
        confirmLabel={confirm ? confirmCopy[confirm.kind].label : ''}
        danger={confirm ? confirmCopy[confirm.kind].danger : false}
        onConfirm={() => confirm && confirmed(confirm)}
        onClose={() => setConfirm(undefined)}
      >
        {confirm && (
          <p>
            <b>
              {confirm.account.displayName} (@{confirm.account.username})
            </b>
            <br />
            {confirmCopy[confirm.kind].body}
          </p>
        )}
      </ConfirmSheet>
      <PromptSheet
        open={Boolean(renaming)}
        title="표시 이름 바꾸기"
        label="표시 이름"
        initial={renaming?.displayName}
        maxLength={80}
        confirmLabel="저장"
        onSubmit={(displayName) => {
          const target = renaming;
          if (!target || displayName === target.displayName) return;
          void run(async () => {
            await accountApi.update(session, target.userId, { displayName });
            await refresh();
            return target.userId === selfId ? '표시 이름을 바꿨어요. 다음 로그인부터 앱 곳곳에 반영돼요.' : undefined;
          });
        }}
        onClose={() => setRenaming(undefined)}
      />
    </PrefSection>
  );
}

/** 계정: who is signed in here, their password and sign-out, and for administrators the member list. */
export function AccountPage() {
  const auth = useOptionalSelfHostAuth();
  const [signingOut, setSigningOut] = useState(false);
  const session = auth?.session;
  if (!auth || !session) return null;
  const { account, capabilities } = session.context;
  const signOut = () => {
    setSigningOut(true);
    // The gate locks the app first; a failed server sign-out is explained on its own screen.
    void auth.logout().catch(() => undefined);
  };

  return (
    <>
      <PrefSection title="내 계정">
        <PrefGroup>
          <div className="un-pref un-account-self">
            <Avatar name={account.displayName || account.username} />
            <span className="un-pref-text">
              <strong>{account.displayName}</strong>
              <small>
                @{account.username} · {ROLE_LABEL[account.role]}
              </small>
            </span>
            <button type="button" className="un-btn is-ghost is-sm" disabled={signingOut} onClick={signOut}>
              <LogOut size={15} />
              로그아웃
            </button>
          </div>
          <Pref
            title="이 브라우저"
            help="로그아웃하면 이 브라우저의 다른 탭과 설치한 앱도 함께 로그아웃돼요. 서버에 맡긴 다운로드나 작업은 계속돼요."
          />
        </PrefGroup>
        <PasswordChange session={session} onChanged={() => void auth.revalidate()} />
      </PrefSection>

      {account.role === 'member' && (
        <PrefSection title="이 서버에서">
          <Notice>
            내 서재, 독서 기록, 소스 로그인은 나만 볼 수 있어요. 쓸 수 있는 소스와 서버 설정, 확장 설치는 관리자가
            정해요.
          </Notice>
        </PrefSection>
      )}

      {capabilities.manageAccounts && <Members session={session} selfId={account.userId} />}
    </>
  );
}
