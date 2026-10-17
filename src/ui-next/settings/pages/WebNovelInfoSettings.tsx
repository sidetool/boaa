import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { BookEnrichmentAutomationController } from '../../../features/book-enrichment/useBookEnrichmentAutomation';
import { NovelpiaAuthSettings } from '../../../features/extensions/NovelpiaAuthSettings';
import { RemoteCollectorAuthBrowser } from '../../../features/extensions/RemoteCollectorAuthBrowser';
import { useWebNovelMetadataSettingsModel } from '../../../features/extensions/use-webnovel-metadata-settings-model';
import type { WebNovelMetadataCollectorAuthPlatform } from '../../../services/webnovel-metadata-collector-client';
import type { WebNovelMetadataCollectorBroker } from '../../../services/webnovel-metadata-collector-broker';
import { ConfirmSheet } from '../../components/dialogs';
import { cx, Progress, Switch } from '../../components/primitives';
import { Notice, Pref, PrefField, PrefGroup, PrefSection, PrefSwitch } from '../../components/prefs';

const PLATFORM: Record<WebNovelMetadataCollectorAuthPlatform, string> = {
  naver_series: '네이버 시리즈',
  kakao_page: '카카오페이지',
  novelpia: '노벨피아',
  ridi: '리디',
};

const CONNECTION = {
  connected: '연결됨',
  checking: '확인 중',
  unavailable: '연결할 수 없음',
  disconnected: '연결 안 됨',
} as const;

/** 웹소설 표지·작품 정보: the collector connection, automatic filling, and adult-title search per platform. */
export function WebNovelInfoSettings({
  broker,
  automation,
  extensionEnabled,
  libraryCount,
}: {
  broker: WebNovelMetadataCollectorBroker;
  automation: BookEnrichmentAutomationController;
  extensionEnabled: boolean;
  libraryCount: number;
}) {
  const model = useWebNovelMetadataSettingsModel(broker, automation);
  const { snapshot, connected, managed, operation } = model;
  const [clearing, setClearing] = useState(false);
  const off = !extensionEnabled;
  const busyConnect = operation === 'connect' || snapshot.connectionState === 'checking';
  const adultReady = connected && snapshot.health?.capabilities.adultAuth.available === true;
  const error = model.error
    ? model.error.cause instanceof Error
      ? model.error.cause.message
      : '요청을 끝내지 못했어요.'
    : snapshot.connectionIssue?.message;

  return (
    <div className="un-webnovel">
      <PrefSection
        title={managed ? '내장 정보 수집기' : '정보 수집기'}
        action={
          <span className={cx('un-srcset-status', connected && 'is-connected')}>
            {connected ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
            {CONNECTION[snapshot.connectionState as keyof typeof CONNECTION] ?? '연결 안 됨'}
          </span>
        }
      >
        {managed ? (
          <button
            type="button"
            className="un-btn is-ghost is-sm un-webnovel-reconnect"
            disabled={off || Boolean(operation)}
            onClick={() => void model.run('connect', () => broker.connect())}
          >
            {busyConnect ? <LoaderCircle size={15} className="un-spin" /> : <RefreshCw size={15} />}
            다시 연결
          </button>
        ) : (
          <form
            className="un-webnovel-endpoint"
            onSubmit={(event) => {
              event.preventDefault();
              void model.connect();
            }}
          >
            <PrefGroup>
              <PrefField label="도우미 주소">
                <input
                  type="url"
                  value={model.endpoint}
                  disabled={off || Boolean(operation)}
                  placeholder="http://127.0.0.1:8000"
                  onChange={(event) => model.setEndpoint(event.target.value)}
                />
              </PrefField>
            </PrefGroup>
            <div className="un-plugin-actions">
              <button type="submit" className="un-btn is-primary is-sm" disabled={off || Boolean(operation)}>
                {busyConnect ? <LoaderCircle size={15} className="un-spin" /> : <RefreshCw size={15} />}
                연결 확인
              </button>
              <button
                type="button"
                className="un-btn is-text is-sm"
                disabled={off || Boolean(operation)}
                onClick={model.resetEndpoint}
              >
                <RotateCcw size={15} />
                기본 주소
              </button>
            </div>
          </form>
        )}
        {!managed && model.remoteEndpoint && (
          <Notice tone="warning">
            원격 도우미에는 찾을 작품의 제목과 작가가 전송돼요. 직접 운영하거나 믿는 주소만 쓰세요.
          </Notice>
        )}
        {snapshot.health && (
          <p className="un-plugin-muted">
            수집기 v{snapshot.health.version} · 표지 최대{' '}
            {Math.round(snapshot.health.capabilities.coverRef.maxBytes / 1024 / 1024)}MB
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </PrefSection>

      <PrefSection title="자동으로 채우기" hint="정확히 맞는 결과만 쓰고, 직접 적은 정보와 있던 표지는 그대로 둬요.">
        <PrefGroup>
          <PrefSwitch
            title="새로 가져온 작품 찾아보기"
            help="서재에 새 작품이 들어오면 표지와 작품 정보 후보를 찾아요."
            checked={snapshot.settings.automaticLookup}
            disabled={off}
            onChange={(on) => broker.updateSettings({ automaticLookup: on })}
          />
          <PrefSwitch
            title="찾은 정보 바로 넣기"
            help="정확히 맞으면 빈 정보와 없는 표지를 바로 채워요."
            checked={snapshot.settings.automaticApply === 'missing_fields'}
            disabled={off}
            onChange={(on) => broker.updateSettings({ automaticApply: on ? 'missing_fields' : 'off' })}
          />
          <Pref
            title="서재 전체 채우기"
            help="정보나 표지가 빈 작품만 찾아서 채워요."
            control={
              automation.busy ? (
                <button type="button" className="un-btn is-ghost is-sm" onClick={automation.cancel}>
                  <Square size={13} />
                  멈추기
                </button>
              ) : (
                <button
                  type="button"
                  className="un-btn is-primary is-sm"
                  disabled={off || !connected || libraryCount === 0}
                  onClick={() => void automation.runLibraryBatch()}
                >
                  채우기
                </button>
              )
            }
          />
        </PrefGroup>
        {model.progress.state === 'running' && (
          <div className="un-webnovel-progress" role="status">
            <Progress value={model.progress.total ? model.progress.completed / model.progress.total : 0} />
            <small>
              {model.progress.completed}/{model.progress.total} · {model.progress.currentTitle ?? '준비 중'}
            </small>
          </div>
        )}
        {model.result && model.result.state !== 'running' && (
          <Notice tone={model.result.failed > 0 ? 'warning' : 'info'}>
            {model.result.state === 'cancelled' ? '멈춤 · ' : ''}
            {model.result.completed}/{model.result.total}권 확인, {model.result.applied}권 채움, 이미 충분한{' '}
            {model.result.skipped}권은 건너뜀
            {model.result.failed > 0
              ? ` · 실패 ${model.result.failed}권 (${model.result.errors[0]?.message ?? '알 수 없는 오류'})`
              : ''}
          </Notice>
        )}
        <p className="un-plugin-muted">
          자동 표지는 원본 사이트의 이미지를 개인 서재에만 보여 줘요. 밖으로 내보내기 전에 쓸 수 있는지 확인하세요.
        </p>
      </PrefSection>

      <PrefSection title="19세 작품 찾기" hint="사이트마다 방식이 달라요. 필요한 로그인은 서버에 보관해서 다시 써요.">
        <PrefGroup>
          <PrefSwitch
            title="19세 결과도 찾기"
            help="아래에서 켠 사이트의 19세 작품도 함께 찾아요."
            checked={snapshot.settings.includeAdult}
            disabled={off || !adultReady}
            onChange={(on) => broker.updateSettings({ includeAdult: on })}
          />
        </PrefGroup>
        {!connected ? (
          <Notice>먼저 위에서 도우미 연결을 확인해 주세요.</Notice>
        ) : !adultReady ? (
          <Notice tone="warning">지금 도우미 환경에서는 로그인 검색을 쓸 수 없어요.</Notice>
        ) : (
          <PrefGroup>
            {model.authPlatforms.map((platform) => {
              const enabled = snapshot.auth?.enabledPlatforms.includes(platform) === true;
              if (snapshot.health?.capabilities.adultAuth.publicSearchPlatforms?.includes(platform))
                return (
                  <Pref
                    key={platform}
                    title={PLATFORM[platform]}
                    help="로그인 없이 찾아요"
                    control={
                      <Switch
                        label={`${PLATFORM[platform]} 19세 찾기`}
                        checked={enabled}
                        disabled={off || Boolean(operation)}
                        onChange={(on) => void (on ? model.finishLogin(platform) : model.disableLogin(platform))}
                      />
                    }
                  />
                );
              if (platform === 'novelpia' && model.directLoginPlatforms.includes(platform))
                return (
                  <div key={platform} className="un-pref is-stacked un-source-legacy">
                    <NovelpiaAuthSettings
                      enabled={enabled}
                      credentialsRemembered={snapshot.auth?.rememberedCredentialPlatforms?.includes(platform) === true}
                      busy={Boolean(operation)}
                      disabled={off || !connected}
                      connectCredentials={(email, password) =>
                        model.run('novelpia-credentials', () => broker.configureNovelpiaCredentials(email, password))
                      }
                      connectLoginKey={(key) =>
                        model.run('novelpia-login-key', () => broker.configureNovelpiaLoginKey(key))
                      }
                      enableSaved={() => model.finishLogin(platform)}
                      disable={() => model.disableLogin(platform)}
                    />
                  </div>
                );
              return (
                <Pref
                  key={platform}
                  title={PLATFORM[platform]}
                  help={enabled ? '켜짐' : '로그인 안 함'}
                  control={
                    <div className="un-plugin-actions">
                      <button
                        type="button"
                        className="un-btn is-ghost is-sm"
                        disabled={Boolean(operation)}
                        onClick={() => void model.openLogin(platform)}
                      >
                        <ExternalLink size={14} />
                        {enabled ? '다시 로그인' : '로그인'}
                      </button>
                      {enabled ? (
                        <button
                          type="button"
                          className="un-btn is-text is-sm"
                          disabled={Boolean(operation)}
                          onClick={() => void model.disableLogin(platform)}
                        >
                          끄기
                        </button>
                      ) : (
                        !model.remoteAuthBrowser && (
                          <button
                            type="button"
                            className="un-btn is-primary is-sm"
                            disabled={Boolean(operation)}
                            onClick={() => void model.finishLogin(platform)}
                          >
                            로그인 끝
                          </button>
                        )
                      )}
                    </div>
                  }
                />
              );
            })}
          </PrefGroup>
        )}
        {snapshot.auth?.sessionSavedAt && (
          <p className="un-plugin-muted">로그인 저장됨 · 만료되면 다시 로그인해 주세요.</p>
        )}
        {snapshot.auth?.browserRunning && (
          <Notice
            action={
              <div className="un-plugin-actions">
                {model.remoteAuthBrowser && model.remotePlatform && (
                  <button
                    type="button"
                    className="un-btn is-text is-sm"
                    onClick={() => model.setRemoteBrowserVisible(true)}
                  >
                    로그인 화면
                  </button>
                )}
                <button
                  type="button"
                  className="un-btn is-text is-sm"
                  onClick={() => void model.run('close-auth', () => broker.closeAuthBrowser())}
                >
                  닫기
                </button>
              </div>
            }
          >
            로그인용 브라우저가 열려 있어요.
          </Notice>
        )}
        {snapshot.authIssue?.message && <Notice tone="danger">{snapshot.authIssue.message}</Notice>}
        {adultReady && (
          <div className="un-plugin-actions">
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={Boolean(operation)}
              onClick={() => void model.run('refresh-auth', () => broker.refreshAuthStatus())}
            >
              <RefreshCw size={14} />
              상태 새로고침
            </button>
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={Boolean(operation)}
              onClick={() => setClearing(true)}
            >
              <Trash2 size={14} />
              로그인 지우기
            </button>
          </div>
        )}
      </PrefSection>

      {model.remotePlatform && model.remoteBrowserVisible && snapshot.auth?.browserRunning && (
        <RemoteCollectorAuthBrowser
          broker={broker}
          platformLabel={PLATFORM[model.remotePlatform]}
          busy={Boolean(operation)}
          onDismiss={() => model.setRemoteBrowserVisible(false)}
          onCancel={() => void model.closeRemoteBrowser()}
          onComplete={() => void model.completeRemoteBrowser()}
        />
      )}
      <ConfirmSheet
        open={clearing}
        title="로그인을 모두 지울까요?"
        confirmLabel="지우기"
        danger
        onConfirm={() => void model.run('clear-auth', () => broker.clearAuthSession())}
        onClose={() => setClearing(false)}
      >
        <p>로그인용 브라우저에 저장된 로그인을 지워요. 다시 쓰려면 로그인해야 해요.</p>
      </ConfirmSheet>
    </div>
  );
}
