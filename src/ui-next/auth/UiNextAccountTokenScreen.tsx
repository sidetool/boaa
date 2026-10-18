import { Check, LogOut, RefreshCw, Server } from 'lucide-react';
import type { FormEvent } from 'react';
import { cx } from '../components/primitives';
import { AuthShell, Field, PasswordInput } from './UiNextAuthScreen';
import '../styles/tokens.css';
import '../styles/components.css';
import './auth.css';

export interface SignedInAccountView {
  readonly displayName: string;
  readonly username: string;
}

function Who({ account }: { account: SignedInAccountView }) {
  return (
    <div className="un-auth-who">
      <span className="un-auth-avatar" aria-hidden="true">
        {[...account.displayName.trim()][0]?.toUpperCase() ?? '?'}
      </span>
      <span>
        <b>{account.displayName}</b>
        <small>@{account.username} · 이 브라우저에 로그인돼 있어요</small>
      </span>
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return message ? (
    <p className="un-auth-error" role="alert">
      {message}
    </p>
  ) : null;
}

/**
 * Invitation or password-reset link. Setting the password never signs in; if another account is signed in
 * here, it must sign out first so the link cannot attach to the wrong session.
 */
export function UiNextAccountTokenScreen(props: {
  readonly kind: 'invitation' | 'password-reset';
  /** Set when another account is signed in on this browser. */
  readonly signedIn?: SignedInAccountView;
  readonly password: string;
  readonly passwordConfirmation: string;
  readonly submitting: boolean;
  readonly message: string;
  readonly onPassword: (value: string) => void;
  readonly onPasswordConfirmation: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onSignOut: () => void;
  readonly onDismiss: () => void;
}) {
  const invitation = props.kind === 'invitation';
  const longEnough = props.password.length >= 10;
  const matches = props.passwordConfirmation.length > 0 && props.password === props.passwordConfirmation;

  if (props.signedIn)
    return (
      <AuthShell>
        <h1 id="un-auth-title">{invitation ? '초대 링크를 열었어요' : '비밀번호 재설정 링크를 열었어요'}</h1>
        <p className="un-auth-lead">
          이 링크는 다른 계정용일 수 있어요. 지금 계정에서 로그아웃한 다음
          {invitation ? ' 초대받은 계정의 비밀번호를 정해요.' : ' 새 비밀번호를 정해요.'}
        </p>
        <Who account={props.signedIn} />
        <Problem message={props.message} />
        <div className="un-auth-actions">
          <button
            type="button"
            className="un-btn is-primary is-lg"
            disabled={props.submitting}
            onClick={props.onSignOut}
          >
            <LogOut size={18} aria-hidden="true" />
            로그아웃하고 계속
          </button>
          <button type="button" className="un-btn is-text" disabled={props.submitting} onClick={props.onDismiss}>
            링크 무시하고 {props.signedIn.displayName}(으)로 계속
          </button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell foot="비밀번호를 정해도 자동으로 로그인되지 않아요">
      <h1 id="un-auth-title">{invitation ? 'BOAA에 초대받았어요' : '새 비밀번호 정하기'}</h1>
      <p className="un-auth-lead">
        {invitation
          ? '쓸 비밀번호를 정하면 초대가 끝나요. 그다음 관리자가 알려 준 아이디로 로그인해요.'
          : '새 비밀번호를 정하면 이 계정은 모든 기기에서 로그아웃돼요. 그다음 새 비밀번호로 로그인해요.'}
      </p>
      <form className="un-auth-form" onSubmit={props.onSubmit}>
        <Field label="새 비밀번호">
          <PasswordInput
            label="새 비밀번호"
            value={props.password}
            onChange={props.onPassword}
            autoComplete="new-password"
            disabled={props.submitting}
          />
        </Field>
        <Field label="비밀번호 확인">
          <PasswordInput
            label="비밀번호 확인"
            value={props.passwordConfirmation}
            onChange={props.onPasswordConfirmation}
            autoComplete="new-password"
            disabled={props.submitting}
          />
        </Field>
        <ul className="un-auth-rules" aria-label="비밀번호 조건">
          <li className={cx(longEnough && 'is-met')}>
            <Check size={14} aria-hidden="true" />
            10자 이상
          </li>
          <li className={cx(matches && 'is-met')}>
            <Check size={14} aria-hidden="true" />두 칸이 같아요
          </li>
        </ul>
        <Problem message={props.message} />
        <button type="submit" className="un-btn is-primary is-lg un-auth-submit" disabled={props.submitting}>
          {props.submitting ? (
            <>
              <RefreshCw size={18} className="un-auth-spin" aria-hidden="true" /> 저장하는 중…
            </>
          ) : (
            '비밀번호 정하기'
          )}
        </button>
      </form>
    </AuthShell>
  );
}

/** A sign-out the server has not confirmed yet. The app stays closed until it is retried or turns out to be done. */
export function UiNextLogoutPendingScreen(props: {
  readonly account: SignedInAccountView;
  readonly submitting: boolean;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <AuthShell>
      <h1 id="un-auth-title">로그아웃을 마무리할게요</h1>
      <p className="un-auth-lead">서버가 로그아웃을 아직 확인하지 못했어요. 그동안 이 계정의 서재는 닫아 두었어요.</p>
      <Who account={props.account} />
      <Problem message={props.message} />
      <div className="un-auth-actions">
        <button type="button" className="un-btn is-primary is-lg" disabled={props.submitting} onClick={props.onRetry}>
          {props.submitting ? (
            <RefreshCw size={18} className="un-auth-spin" aria-hidden="true" />
          ) : (
            <LogOut size={18} aria-hidden="true" />
          )}
          {props.submitting ? '로그아웃하는 중…' : '로그아웃 다시 시도'}
        </button>
      </div>
    </AuthShell>
  );
}

/** Opaque cover while a returning tab confirms its account. Rendered over the still-mounted app. */
export function UiNextAuthLock(props: { readonly failed: boolean; readonly onRetry: () => void }) {
  return (
    <div className="ui-next un-auth-lock" role="dialog" aria-modal="true" aria-label="계정 확인">
      <div className="un-auth-lock-card">
        {props.failed ? (
          <>
            <Server size={22} aria-hidden="true" />
            <p role="alert">서버에 닿지 못해 계정을 확인하지 못했어요. 연결되면 바로 이어서 열려요.</p>
            <button type="button" className="un-btn is-primary" onClick={props.onRetry}>
              다시 확인
            </button>
          </>
        ) : (
          <p role="status" className="un-auth-wait">
            <RefreshCw size={20} className="un-auth-spin" aria-hidden="true" />
            계정을 확인하는 중…
          </p>
        )}
      </div>
    </div>
  );
}
