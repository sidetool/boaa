import type { ProductPluginSession } from '../../../extensions/platform/product-session';
import type { Installation } from '../../../extensions/platform/store-model';
import { usePluginConnectionModel } from '../../../extensions/platform/use-plugin-connection-model';
import { Notice, PrefField, PrefFold, PrefSwitch } from '../../components/prefs';

function Connection({ session, row, slot }: { session: ProductPluginSession; row: Installation; slot: string }) {
  const model = usePluginConnectionModel({ session, row, slot });
  const saved = model.saved;
  return (
    <PrefFold
      title={`${slot} 외부 연결`}
      summary={saved ? `허락함 · ${saved.authenticated ? '키 보관 중' : '인증 없음'}` : '아직 허락 안 함'}
    >
      <form
        className="un-plugin-connection"
        onSubmit={(event) => {
          event.preventDefault();
          void model.approve();
        }}
      >
        <fieldset disabled={model.disabled}>
          <Notice>요청은 BOAA 서버에서 나가요. 본문 읽기 권한도 허락했다면 본문이 이 주소로 갈 수 있어요.</Notice>
          <PrefField label="API 주소" help="/로 끝나는 API 경로를 적어 주세요.">
            <input
              type="url"
              required
              value={model.endpoint}
              placeholder="https://api.example.com/v1/"
              onChange={(event) => model.setEndpoint(event.target.value)}
            />
          </PrefField>
          <PrefField label="인증 방식">
            <select aria-label="인증 방식" value={model.auth} onChange={(event) => model.setAuth(event.target.value)}>
              <option value="none">없음 (저장하면 보관한 키를 지워요)</option>
              <option value="bearer">Bearer 토큰</option>
              <option value="header">API 키 헤더</option>
            </select>
          </PrefField>
          {model.auth === 'header' && (
            <PrefField label="키 헤더 이름">
              <input value={model.header} onChange={(event) => model.setHeader(event.target.value)} />
            </PrefField>
          )}
          {model.auth !== 'none' && (
            <PrefField label="키" help="플러그인에는 키를 넘기지 않아요. 바꾸려면 다시 적어 주세요.">
              <input
                aria-label="인증정보"
                type="password"
                autoComplete="off"
                required
                value={model.secret}
                onChange={(event) => model.setSecret(event.target.value)}
              />
            </PrefField>
          )}
          <PrefField label="보낼 수 있는 일반 헤더" help="쉼표로 나눠요. 인증·쿠키·전송 제어 헤더는 적을 수 없어요.">
            <input value={model.allowedHeaders} onChange={(event) => model.setAllowedHeaders(event.target.value)} />
          </PrefField>
          <div className="un-plugin-connection-choice">
            <span>허락할 요청</span>
            <div className="un-pref-chips" role="group" aria-label="허락할 요청">
              {model.methodOptions.map((method) => (
                <button
                  key={method}
                  type="button"
                  aria-pressed={model.methods.includes(method)}
                  className={`un-chip${model.methods.includes(method) ? ' is-active' : ''}`}
                  onClick={() => model.setMethod(method, !model.methods.includes(method))}
                >
                  {method}
                </button>
              ))}
            </div>
          </div>
          {model.roleOptions.map((role) => (
            <PrefSwitch
              key={role}
              title={role === 'controller' ? '자동 작업·명령에서 쓰기' : '플러그인 화면에서 쓰기'}
              checked={model.roles.includes(role)}
              onChange={(on) => model.setRole(role, on)}
            />
          ))}
          <div className="un-plugin-actions">
            <button type="submit" className="un-btn is-primary is-sm">
              허락하고 저장
            </button>
            {saved && (
              <button type="button" className="un-btn is-ghost is-sm" onClick={() => void model.revoke()}>
                허락 거두기
              </button>
            )}
          </div>
        </fieldset>
        {model.error && (
          <Notice tone="danger">
            {model.error === 'load_failed'
              ? '연결 설정을 불러오지 못했어요.'
              : '허락하지 못했어요. 주소·권한·서버가 허락하는 범위를 확인해 주세요.'}
          </Notice>
        )}
      </form>
    </PrefFold>
  );
}

/** One fold per connection slot the plugin declares. Nothing when it declares none. */
export function PluginConnectionFolds({ session, row }: { session: ProductPluginSession; row: Installation }) {
  const slots = row.manifest?.contributes.connections;
  if (!slots?.length) return null;
  return (
    <>
      {slots.map((slot) => (
        <Connection key={`${row.revision}:${slot}`} session={session} row={row} slot={slot} />
      ))}
    </>
  );
}
