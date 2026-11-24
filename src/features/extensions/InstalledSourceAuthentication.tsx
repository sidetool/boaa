import { useEffect, useRef, useState } from 'react';
import type {
  SourceAuthentication,
  SourceAuthenticationRequest,
  SourceAuthenticationStatus,
} from '@boaa/extension-contracts/package';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';

const labels: Record<SourceAuthenticationStatus['state'], string> = {
  missing: '저장된 연결이 없습니다.',
  saved: '연결이 저장돼 있습니다. 필요하면 다시 확인할 수 있습니다.',
  valid: '인증을 확인했습니다.',
  invalid: '인증을 확인하지 못했습니다. 입력한 값이나 세션 만료 여부를 확인해 주세요.',
  forbidden: '이 계정으로 접근할 수 없습니다. 사이트에서 이용 권한을 확인해 주세요.',
  error: '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};
interface AuthenticationProps {
  manager: InstalledExtensionManager;
  auth: SourceAuthentication;
  disabled: boolean;
}

export function InstalledSourceAuthentication(props: AuthenticationProps) {
  const { manager, auth } = props;
  // Account changes replace the manager even when the installed source id stays the same.
  const [owner, setOwner] = useState({ manager, generation: 0 });
  if (owner.manager !== manager) setOwner({ manager, generation: owner.generation + 1 });
  const key = JSON.stringify([owner.generation, auth.sourceId, auth.origin, auth.scheme, auth.cookieName]);
  return <AuthenticationForm key={key} {...props} />;
}

function AuthenticationForm({ manager, auth, disabled }: AuthenticationProps) {
  const [state, setState] = useState<SourceAuthenticationStatus>();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const lookup = useRef<AbortController>();
  const action = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    lookup.current = controller;
    void manager
      .authenticate?.(auth.sourceId, { action: 'status' }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setState(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ state: 'error' });
      });
    return () => {
      controller.abort();
      action.current?.abort();
    };
  }, [manager, auth.sourceId]);

  const run = async (request: SourceAuthenticationRequest) => {
    if (disabled || !manager.authenticate || action.current) return;
    lookup.current?.abort();
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    try {
      const result = await manager.authenticate(auth.sourceId, request, controller.signal);
      if (controller.signal.aborted) return;
      setState(result);
      if (
        (request.action === 'save' && (result.state === 'valid' || result.state === 'saved')) ||
        (request.action === 'remove' && result.state === 'missing')
      ) {
        setUsername('');
        setSecret('');
      }
    } catch {
      if (!controller.signal.aborted) setState({ state: 'error' });
    } finally {
      if (!controller.signal.aborted) {
        action.current = undefined;
        setBusy(false);
      }
    }
  };
  return (
    <details className="installed-source-authentication">
      <summary>{auth.label}</summary>
      <p className="field-help installed-extension-origin">{auth.origin}</p>
      <p className="field-help" role="status">
        {busy ? '인증을 확인하고 있습니다…' : state ? labels[state.state] : '연결 상태 확인 중…'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run({ action: 'save', credential: { secret, ...(auth.scheme === 'basic' ? { username } : {}) } });
        }}
      >
        <fieldset disabled={busy || disabled || !manager.authenticate}>
          {auth.scheme === 'basic' && (
            <label>
              아이디
              <input
                type="text"
                autoComplete="username"
                value={username}
                maxLength={256}
                required
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
          )}
          <label>
            {auth.scheme === 'basic'
              ? '비밀번호'
              : auth.scheme === 'cookie'
                ? `${auth.cookieName} 쿠키 값`
                : '접속 토큰'}
            <input
              type="password"
              autoComplete={auth.scheme === 'basic' ? 'current-password' : 'off'}
              value={secret}
              maxLength={8192}
              required
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <p className="field-help">
            확인된 연결은 {manager.target === 'server' ? '서버' : '이 기기'}에 암호화해 보관합니다. 실패하면 기존 연결을
            유지합니다.
          </p>
          <div className="installed-extension-actions">
            <button type="submit" disabled={!secret}>
              확인 후 저장
            </button>
            <button type="button" onClick={() => void run({ action: 'check' })}>
              연결 확인
            </button>
            <button type="button" onClick={() => void run({ action: 'remove' })}>
              연결 삭제
            </button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}
