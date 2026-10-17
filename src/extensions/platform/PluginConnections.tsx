import type { ProductPluginSession } from './product-session';
import type { Installation } from './store-model';
import { usePluginConnectionModel } from './use-plugin-connection-model';
export function PluginConnections({ session, row }: { session: ProductPluginSession; row: Installation }) {
  const slots = row.manifest?.contributes.connections;
  return slots?.length ? (
    <section aria-label="플러그인 외부 연결">
      {slots.map((slot) => (
        <Connection key={`${row.revision}:${slot}`} {...{ session, row, slot }} />
      ))}
    </section>
  ) : null;
}
function Connection({ session, row, slot }: { session: ProductPluginSession; row: Installation; slot: string }) {
  const {
    saved,
    endpoint,
    setEndpoint,
    auth,
    setAuth,
    header,
    setHeader,
    allowedHeaders,
    setAllowedHeaders,
    secret,
    setSecret,
    methods,
    roles,
    error: errorCode,
    approve,
    revoke,
    methodOptions,
    roleOptions,
    setMethod,
    setRole,
    disabled,
  } = usePluginConnectionModel({ session, row, slot });
  const error =
    errorCode === 'load_failed'
      ? '연결 설정을 불러오지 못했습니다.'
      : errorCode === 'mutation_failed'
        ? '연결을 승인하지 못했습니다. 주소·권한·서버의 허용 범위를 확인해 주세요.'
        : '';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void approve();
      }}
    >
      <fieldset disabled={disabled}>
        <legend>{slot} · 외부 연결</legend>
        <p>
          요청은 BOAA 서버에서 나갑니다. 주소는 /로 끝나는 API 경로를 입력하세요. 본문 읽기 권한을 함께 승인하면 본문을
          이 서버로 보낼 수 있습니다.
        </p>
        {saved && (
          <p role="status">
            승인됨 · {saved.endpoint} · {saved.authenticated ? '인증정보 보관 중' : '인증 없음'}
          </p>
        )}
        <label>
          API 주소
          <input
            type="url"
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.example.com/v1/"
          />
        </label>
        <label>
          인증 방식
          <select aria-label="인증 방식" value={auth} onChange={(e) => setAuth(e.target.value)}>
            <option value="none">없음 (저장 시 기존 키 제거)</option>
            <option value="bearer">Bearer 토큰</option>
            <option value="header">API 키 헤더</option>
          </select>
        </label>
        {auth === 'header' && (
          <label>
            키 헤더
            <input value={header} onChange={(e) => setHeader(e.target.value)} />
          </label>
        )}
        {auth !== 'none' && (
          <label>
            인증정보
            <input
              aria-label="인증정보"
              type="password"
              autoComplete="off"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <small>플러그인에는 키를 전달하지 않습니다. 변경하려면 다시 입력하세요.</small>
          </label>
        )}
        <label>
          허용할 일반 헤더
          <input value={allowedHeaders} onChange={(e) => setAllowedHeaders(e.target.value)} />
          <small>쉼표로 구분합니다. 인증·쿠키·전송 제어 헤더는 직접 지정할 수 없습니다.</small>
        </label>
        <fieldset>
          <legend>허용할 요청</legend>
          {methodOptions.map((m) => (
            <label className="product-plugin-toggle" key={m}>
              <input type="checkbox" checked={methods.includes(m)} onChange={(e) => setMethod(m, e.target.checked)} />
              {m}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>연결을 사용할 코드</legend>
          {roleOptions.map((r) => (
            <label className="product-plugin-toggle" key={r}>
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRole(r, e.target.checked)} />
              {r === 'controller' ? '자동 작업·명령' : '플러그인 화면'}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary-btn">
          연결 승인·저장
        </button>
        {saved && (
          <button type="button" className="ghost-btn" onClick={() => void revoke()}>
            연결 철회
          </button>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
