import { ArrowRight, Check, Eye, EyeOff, RefreshCw, Server } from 'lucide-react';
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { cx } from '../components/primitives';
import '../styles/tokens.css';
import '../styles/components.css';
import './auth.css';

export interface UiNextAuthScreenProps {
  readonly mode: 'loading' | 'setup' | 'login' | 'error';
  readonly message: string;
  readonly submitting: boolean;
  readonly setupCodeRequired: boolean;
  readonly setupCodeSource?: 'server-log' | null;
  readonly legacySetupCodeAccepted?: boolean;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly passwordConfirmation: string;
  readonly setupCode: string;
  readonly onUsername: (value: string) => void;
  readonly onDisplayName: (value: string) => void;
  readonly onPassword: (value: string) => void;
  readonly onPasswordConfirmation: (value: string) => void;
  readonly onSetupCode: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onRetry: () => void;
}

// Decorative cover wall behind the form; hues only, no artwork.
const WALL = [212, 18, 268, 160, 32, 340, 196, 120, 290, 8, 230, 48, 180, 316, 90, 250, 140, 0];

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="un-auth-field">
      <span className="un-auth-label">{label}</span>
      {children}
      {hint}
    </label>
  );
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  label: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="un-auth-password">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
        minLength={10}
        maxLength={256}
      />
      <button
        type="button"
        className="un-auth-reveal"
        aria-label={visible ? `${label} 숨기기` : `${label} 보기`}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </span>
  );
}

/** ui-next sign-in: a quiet full-screen page over a dimmed cover wall, one column on every size. */
export function UiNextAuthScreen(props: UiNextAuthScreenProps) {
  const setup = props.mode === 'setup';
  const longEnough = props.password.length >= 10;
  const matches = props.passwordConfirmation.length > 0 && props.password === props.passwordConfirmation;

  return (
    <main className="ui-next un-auth">
      <div className="un-auth-wall" aria-hidden="true">
        {[...WALL, ...WALL, ...WALL, ...WALL].map((hue, index) => (
          <span key={index} style={{ '--un-auth-hue': hue } as CSSProperties} />
        ))}
      </div>

      <section className="un-auth-panel" aria-labelledby="un-auth-title">
        <p className="un-auth-logo" aria-hidden="true">
          BOAA
          <i />
        </p>
        <h1 id="un-auth-title">
          {setup ? '내 서재 만들기' : props.mode === 'login' ? '다시 오신 걸 환영해요' : '서버에 연결하는 중'}
        </h1>
        <p className="un-auth-lead">
          {setup
            ? '이 서버의 첫 계정이에요. 이미 있는 서버 책장은 이 계정에 그대로 이어져요.'
            : props.mode === 'login'
              ? '한 번 로그인하면 이 기기에서는 다음부터 바로 열려요.'
              : props.mode === 'loading'
                ? '개인 서버의 로그인 상태를 확인하고 있어요.'
                : '개인 서버에 닿지 못했어요.'}
        </p>

        {props.mode === 'loading' && (
          <div className="un-auth-wait" role="status">
            <RefreshCw size={20} className="un-auth-spin" aria-hidden="true" />
            확인 중…
          </div>
        )}

        {props.mode === 'error' && (
          <div className="un-auth-problem" role="alert">
            <Server size={20} aria-hidden="true" />
            <p>{props.message}</p>
            <button type="button" className="un-btn is-primary is-lg" onClick={props.onRetry}>
              다시 확인
            </button>
          </div>
        )}

        {(setup || props.mode === 'login') && (
          <form className="un-auth-form" onSubmit={props.onSubmit}>
            <Field label="아이디">
              <input
                value={props.username}
                onChange={(event) => props.onUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                minLength={2}
                maxLength={64}
                autoFocus
              />
            </Field>
            {setup && props.setupCodeRequired && (
              <Field
                label="초기 설정 코드"
                hint={
                  <small id="un-auth-code-help" className="un-auth-hint">
                    {props.setupCodeSource === 'server-log' ? (
                      <>
                        서버를 처음 켤 때 로그에 나온 12자리 코드예요. <code>docker compose logs api</code>로 볼 수
                        있어요.
                      </>
                    ) : (
                      '서버 관리자에게 받은 코드를 넣어 주세요.'
                    )}
                    {props.legacySetupCodeAccepted && (
                      <> 예전에 설치했다면 .env의 READER_AUTH_TOKEN 값도 쓸 수 있어요.</>
                    )}
                  </small>
                }
              >
                <input
                  value={props.setupCode}
                  onChange={(event) => props.onSetupCode(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX"
                  required
                  aria-describedby="un-auth-code-help"
                />
              </Field>
            )}
            {setup && (
              <Field
                label={
                  <>
                    표시 이름 <small>선택</small>
                  </>
                }
              >
                <input
                  value={props.displayName}
                  onChange={(event) => props.onDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  placeholder="비워 두면 아이디를 써요"
                />
              </Field>
            )}
            <Field label="비밀번호">
              <PasswordInput
                label="비밀번호"
                value={props.password}
                onChange={props.onPassword}
                autoComplete={setup ? 'new-password' : 'current-password'}
              />
            </Field>
            {setup && (
              <Field label="비밀번호 확인">
                <PasswordInput
                  label="비밀번호 확인"
                  value={props.passwordConfirmation}
                  onChange={props.onPasswordConfirmation}
                  autoComplete="new-password"
                />
              </Field>
            )}
            {setup && (
              <ul className="un-auth-rules" aria-label="비밀번호 조건">
                <li className={cx(longEnough && 'is-met')}>
                  <Check size={14} aria-hidden="true" />
                  10자 이상
                </li>
                <li className={cx(matches && 'is-met')}>
                  <Check size={14} aria-hidden="true" />두 칸이 같아요
                </li>
              </ul>
            )}
            {props.message && (
              <p className="un-auth-error" role="alert">
                {props.message}
              </p>
            )}
            <button type="submit" className="un-btn is-primary is-lg un-auth-submit" disabled={props.submitting}>
              {props.submitting ? (
                <>
                  <RefreshCw size={18} className="un-auth-spin" aria-hidden="true" /> 확인 중…
                </>
              ) : (
                <>
                  {setup ? '계정 만들고 시작' : '로그인'} <ArrowRight size={18} aria-hidden="true" />
                </>
              )}
            </button>
          </form>
        )}

        <p className="un-auth-foot">개인용 서버 · 내 기기와 서재만 연결돼요</p>
      </section>
    </main>
  );
}
