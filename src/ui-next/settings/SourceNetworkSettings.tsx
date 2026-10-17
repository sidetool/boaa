import { ChevronDown, Globe2, LoaderCircle, RefreshCw, ShieldHalf, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import {
  useSourceNetworkSettingsModel,
  type SourceNetworkMode,
} from '../../features/extensions/use-source-network-settings-model';
import { Notice, PrefField, PrefOptions } from '../components/prefs';

function byedpiHint(byedpi: { available: boolean; enabled: boolean; running: boolean } | undefined) {
  if (!byedpi?.available) return '이 서버에는 설치돼 있지 않아요.';
  if (byedpi.enabled && byedpi.running) return '켜져 있어요. 주소를 입력할 필요가 없어요.';
  if (byedpi.enabled) return '다시 시작하는 중이에요…';
  return '서버에 들어 있는 우회 프록시를 켜고 바로 연결해요.';
}

/**
 * 기본 연결 방식: how sources that follow the host default reach the network. Per-source exceptions stay in
 * each extension's options; external Suwayomi servers keep their own proxy settings.
 */
export function SourceNetworkSettings({ manager }: { manager: InstalledExtensionManager }) {
  const model = useSourceNetworkSettingsModel(manager);
  if (!model.available) return null;
  const { snapshot } = model;
  const where = model.target === 'device' ? '이 PC' : 'BOAA 서버';
  const byedpi = snapshot?.byedpi;
  const options: { value: SourceNetworkMode; label: string; hint: string; leading: ReactNode }[] = [
    {
      value: 'direct',
      label: '직접 연결',
      hint: `${where}의 인터넷으로 바로 연결해요.`,
      leading: <Globe2 size={18} />,
    },
  ];
  if (byedpi)
    options.push({
      value: 'byedpi',
      label: 'ByeDPI 우회',
      hint: byedpiHint(byedpi),
      leading: <ShieldHalf size={18} />,
    });
  options.push({
    value: 'custom',
    label: '내 프록시',
    hint:
      snapshot?.defaultProxy && model.mode !== 'custom'
        ? `저장한 주소: ${snapshot.defaultProxy}`
        : '직접 입력한 프록시로 연결해요.',
    leading: <Waypoints size={18} />,
  });
  const effective = snapshot?.effectiveProxy;

  return (
    <details
      className="un-pref-fold un-network"
      onToggle={(event) => {
        if (event.currentTarget.open && !snapshot) void model.load();
      }}
    >
      <summary>
        기본 연결 방식
        <small>소스 요청이 {where}에서 나가는 방법</small>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      <div className="un-network-body">
        {snapshot && (
          <>
            <PrefOptions<SourceNetworkMode>
              label="기본 연결 방식"
              value={model.choice ?? model.mode ?? 'direct'}
              disabled={model.busy}
              onChange={(mode) => {
                if (mode === 'byedpi' && !byedpi?.available) return;
                model.select(mode);
              }}
              options={options}
            />

            {model.choice === 'byedpi' && model.byedpiStalled && (
              <Notice tone="warning">
                ByeDPI가 응답하지 않아 다시 시작하고 있어요. 그동안 기본 연결을 따르는 소스는 직접 연결로 바꾸지 않고
                잠시 멈춰요. 급하면 다른 연결 방식을 고르세요.
              </Notice>
            )}

            {model.choice === 'custom' && (
              <form
                className="un-network-custom"
                onSubmit={(event) => {
                  event.preventDefault();
                  model.saveCustom();
                }}
              >
                <PrefField
                  label="프록시 주소"
                  help="http, https, socks5 주소를 쓸 수 있어요. 로그인이 필요한 프록시는 안 돼요."
                >
                  <input
                    className="un-input"
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={model.busy}
                    value={model.address}
                    placeholder="socks5://proxy:1080"
                    onChange={(event) => model.setAddress(event.target.value)}
                  />
                </PrefField>
                <div className="un-network-actions">
                  <button type="submit" className="un-btn is-primary is-sm" disabled={model.busy}>
                    저장
                  </button>
                  {snapshot.origin !== 'environment' && (
                    <button
                      type="button"
                      className="un-btn is-text is-sm"
                      disabled={model.busy}
                      onClick={model.restoreEnvironment}
                    >
                      서버 기본값으로
                    </button>
                  )}
                </div>
              </form>
            )}

            <p className="un-network-now">
              지금 연결:{' '}
              <b>
                {model.mode === 'byedpi'
                  ? byedpi?.running
                    ? 'ByeDPI'
                    : 'ByeDPI (시작 대기)'
                  : effective || snapshot.defaultProxy || '직접 연결'}
              </b>
              {snapshot.origin === 'environment' && model.mode === 'custom' && ' · 서버 기본값'}
            </p>
          </>
        )}

        {model.busy && (
          <p className="un-network-now" role="status">
            <LoaderCircle size={14} className="un-spin" aria-hidden="true" /> 처리 중…
          </p>
        )}
        {model.error && <Notice tone="danger">{model.error}</Notice>}
        {model.message && (
          <p className="un-network-now" role="status">
            {model.message}
          </p>
        )}
        {!snapshot && !model.busy && model.error && (
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => void model.load()}>
            <RefreshCw size={15} aria-hidden="true" />
            다시 불러오기
          </button>
        )}

        <Notice>
          BOAA가 실행하는 소스 확장·APK·브라우저 요청에 적용돼요. 소스마다 다른 연결이 필요하면 각 확장의 옵션에서 바꿀
          수 있어요. 외부 Suwayomi 서버는 그 서버의 프록시 설정을 따르고, 여기서 바꾸지 않아요.
        </Notice>
      </div>
    </details>
  );
}
