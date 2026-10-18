import {
  AlertTriangle,
  BadgeCheck,
  ChevronDown,
  FilePlus2,
  Globe,
  KeyRound,
  Link2,
  ListPlus,
  Monitor,
  PackageOpen,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ApkExtensionsPanel } from '../../features/extensions/ApkExtensionsPanel';
import { ExtensionUpdatesPanel } from '../../features/extensions/ExtensionUpdatesPanel';
import type { InstalledExtensionsPanelProps } from '../../features/extensions/installed-extensions-contract';
import { InstalledSourceAuthentication } from '../../features/extensions/InstalledSourceAuthentication';
import { InstalledSourceContentConnection } from '../../features/extensions/InstalledSourceContentConnection';
import { InstalledSourcePreferences } from '../../features/extensions/InstalledSourcePreferences';
import { PortableSourceVault } from '../../features/extensions/PortableSourceVault';
import { SourceExtensionManagerPanel } from '../../features/extensions/SourceExtensionManagerPanel';
import type { PackageReview } from '../../extensions/packages/installed-extension-manager';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { useSelfHostCapability } from '../../features/auth/self-host-account-api';
import { Notice } from '../components/prefs';
import { cx, Segmented, Switch } from '../components/primitives';
import { ExtensionAvatar } from './ExtensionAvatar';
import { SourceNetworkSettings } from './SourceNetworkSettings';
import './extensions.css';
import { UiNextRepositoryCatalog } from './UiNextRepositoryCatalog';

type Props = InstalledExtensionsPanelProps;
type Tab = 'installed' | 'add' | 'updates';
type Kind = 'boaa' | 'mangayomi' | 'apk' | 'suwayomi';
type Review = { file: File; plan: PackageReview };

const KIND_LABEL: Record<Kind, string> = {
  boaa: 'Boaa 패키지',
  mangayomi: 'Mangayomi JS',
  apk: 'APK',
  suwayomi: 'Suwayomi',
};

function permissionLabel(permission: string) {
  if (permission === 'external.source.download') return '선택한 작품의 회차 가져오기';
  if (permission === 'external.source.list') return '외부 작품 검색과 목록 조회';
  return '작품 정보·표지 후보 제안';
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="un-ext-empty">
      <span className="un-ext-empty-icon">{icon}</span>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** ui-next 확장: one list of what is installed, one place to add more, one place for updates. */
export function UiNextExtensionsPanel({
  manager,
  suwayomi,
  sourceTarget,
  onSourceTargetChange,
  updatesRequest = 0,
}: Props) {
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  /** Members use the sources an administrator allowed; installing, updating and removing code is the administrator's. */
  const manage = useSelfHostCapability('manageExtensions');
  const [tabChoice, setTab] = useState<Tab>(updatesRequest > 0 ? 'updates' : 'installed');
  const kinds: Kind[] = [
    ...(manager.listRepositories ? (['boaa'] as const) : []),
    ...(manager.mangayomi ? (['mangayomi'] as const) : []),
    ...(manager.apk ? (['apk'] as const) : []),
    ...(suwayomi && !manager.apk ? (['suwayomi'] as const) : []),
  ];
  const [kind, setKind] = useState<Kind | undefined>(kinds[0]);
  const activeKind = kind && kinds.includes(kind) ? kind : kinds[0];
  const [routedRepository, setRoutedRepository] = useState<{ kind: Kind; url: string }>();
  const [installedView, setInstalledView] = useState(false);
  // Members reach the APK/JS installed lists through 'add', which then shows only their installed sources.
  const tab: Tab = manage ? tabChoice : tabChoice === 'add' && installedView ? 'add' : 'installed';
  const [review, setReview] = useState<Review>();
  const [reviewLocation, setReviewLocation] = useState<string>();
  const [acceptedChange, setAcceptedChange] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [operationLabel, setOperationLabel] = useState<string>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const operation = useRef<AbortController>();
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewFocus = useRef<HTMLElement>(null);

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (updatesRequest) setTab('updates');
  }, [updatesRequest]);
  useEffect(() => {
    if (review) reviewFocus.current?.focus({ preventScroll: true });
  }, [review]);

  const run = async (task: (signal: AbortSignal) => Promise<void>, label = '확장 작업') => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setOperationLabel(label);
    setError(undefined);
    setMessage(undefined);
    try {
      await task(controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        packageOperationMessage(cause) ??
          (cause instanceof Error && /[가-힣]/.test(cause.message)
            ? cause.message
            : '작업을 완료하지 못했습니다. 파일과 연결 상태를 확인한 뒤 다시 시도해 주세요.'),
      );
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
        setOperationLabel(undefined);
      }
    }
  };

  const packages = snapshot.packages.filter((pkg) => pkg.active);
  const mangayomiSources = snapshot.sources.filter((source) => source.mangayomiPackageId).length;
  const apkSources = snapshot.sources.filter((source) => source.apkPackageId).length;
  const installedTotal = packages.length + mangayomiSources + apkSources;
  // Compatibility sources are listed only while enabled, so only BOAA packages can be off here.
  const enabledTotal = packages.filter((pkg) => pkg.enabled).length + mangayomiSources + apkSources;
  const where = manager.target === 'server' ? '서버' : '이 기기';

  const openKind = (next: Kind, options: { installed?: boolean; repository?: string } = {}) => {
    setKind(next);
    setInstalledView(Boolean(options.installed));
    setRoutedRepository(options.repository ? { kind: next, url: options.repository } : undefined);
    setTab('add');
  };

  const needsAcknowledgement = review?.plan.publisherChanged || review?.plan.downgrade;
  const reviewCard = review && (
    <section ref={reviewFocus} tabIndex={-1} className="un-ext-review" aria-label="확장 설치 확인">
      <header>
        <ExtensionAvatar name={review.plan.package.manifest.extension.name} />
        <div>
          <strong>{review.plan.package.manifest.extension.name}</strong>
          <small>
            v{review.plan.package.manifest.extension.version} · {review.plan.package.manifest.extension.id}
          </small>
        </div>
      </header>
      <p className={cx('un-ext-trust', !review.plan.package.publisherFingerprint && 'is-warn')}>
        {review.plan.package.publisherFingerprint ? (
          <BadgeCheck size={16} aria-hidden="true" />
        ) : (
          <ShieldAlert size={16} aria-hidden="true" />
        )}
        {review.plan.package.publisherFingerprint
          ? '게시자 서명이 있어요. 알고 있는 게시자인지 확인해 주세요.'
          : '서명이 없는 파일이에요. 믿을 수 있는 곳에서 받았는지 확인해 주세요.'}
      </p>
      <div className="un-ext-access">
        <span>요청하는 권한</span>
        <ul>
          {review.plan.package.manifest.extension.permissions.map((permission) => (
            <li key={permission}>
              <Sparkles size={15} aria-hidden="true" />
              {permissionLabel(permission)}
            </li>
          ))}
          {review.plan.package.manifest.requestedAccess.networkOrigins.map((origin) => (
            <li key={origin}>
              <Globe size={15} aria-hidden="true" />
              <code>{origin}</code>
            </li>
          ))}
          {review.plan.package.manifest.requestedAccess.storageKiB > 0 && (
            <li>
              <PackageOpen size={15} aria-hidden="true" />
              소스 데이터 저장 · 최대 {review.plan.package.manifest.requestedAccess.storageKiB} KiB
            </li>
          )}
          {review.plan.package.manifest.requestedAccess.webview && (
            <li>
              <Monitor size={15} aria-hidden="true" />
              사이트 화면 실행 · 확장 전용 브라우저 세션 저장
            </li>
          )}
          {review.plan.package.manifest.requestedAccess.authentication?.map((auth) => (
            <li key={auth.sourceId}>
              <KeyRound size={15} aria-hidden="true" />
              계정 연결 · {auth.label} · <code>{auth.origin}</code>
            </li>
          ))}
          {review.plan.package.manifest.updates && (
            <li>
              <RefreshCw size={15} aria-hidden="true" />
              업데이트 저장소 · <code>{review.plan.package.manifest.updates.repository}</code>
            </li>
          )}
          {review.plan.package.manifest.requestedAccess.contentServices?.map((service) => (
            <li key={`content-${service.sourceId}`}>
              <Link2 size={15} aria-hidden="true" />
              외부 본문 공급자 · <code>{service.origins.join(', ')}</code> · 별도 연결 승인 필요
            </li>
          ))}
        </ul>
      </div>
      {review.plan.publisherChanged && (
        <p className="un-ext-trust is-warn">
          <AlertTriangle size={16} aria-hidden="true" />
          기존 확장과 게시자 서명이 달라요.
        </p>
      )}
      {review.plan.downgrade && (
        <p className="un-ext-trust is-warn">
          <AlertTriangle size={16} aria-hidden="true" />
          지금보다 이전 버전으로 바꿔요.
        </p>
      )}
      {needsAcknowledgement && (
        <label className="un-ext-check">
          <input
            type="checkbox"
            checked={acceptedChange}
            onChange={(event) => setAcceptedChange(event.target.checked)}
          />
          위 변경 사항을 확인했어요
        </label>
      )}
      <footer>
        <button type="button" className="un-btn is-ghost" disabled={busy} onClick={() => setReview(undefined)}>
          취소
        </button>
        <button
          type="button"
          className="un-btn is-primary"
          disabled={busy || (!!needsAcknowledgement && !acceptedChange)}
          onClick={() =>
            void run(
              async (signal) => {
                await manager.install(review.file, review.plan, signal);
                setReview(undefined);
                setTab('installed');
                setMessage(
                  review.plan.operation === 'update'
                    ? `${review.plan.package.manifest.extension.name}을(를) v${review.plan.package.manifest.extension.version}(으)로 업데이트했어요.`
                    : `${review.plan.package.manifest.extension.name}을(를) 설치했어요. 탐색에서 바로 쓸 수 있어요.`,
                );
              },
              review.plan.operation === 'update' ? '확장 업데이트' : '확장 설치',
            )
          }
        >
          {review.plan.operation === 'update' ? '업데이트' : '설치'}
        </button>
      </footer>
    </section>
  );

  const status = (busy || error || message || snapshot.error) && (
    <div className="un-ext-status">
      {busy && (
        <p role="status" className="is-busy">
          <RefreshCw size={15} className="un-ext-spin" aria-hidden="true" />
          {operationLabel} 중…
        </p>
      )}
      {error && (
        <p role="alert" className="is-error">
          {error}
        </p>
      )}
      {message && !busy && <p role="status">{message}</p>}
      {snapshot.error && !error && <p role="status">{snapshot.error}</p>}
    </div>
  );

  const installedList = (
    <div className="un-ext-list" aria-label="사용 중인 콘텐츠 소스 패키지">
      {packages.map((pkg) => {
        const manifest = pkg.active!.manifest;
        const open = expanded === pkg.id;
        const failed = snapshot.errors.some((entry) => entry.packageId === pkg.id);
        const sourceCount = manifest.extension.contributes?.externalSources?.length ?? 0;
        return (
          <article key={pkg.id} className={cx('un-ext-item', open && 'is-open', !pkg.enabled && 'is-off')}>
            <div className="un-ext-item-row">
              <button
                type="button"
                className="un-ext-item-main"
                aria-expanded={open}
                onClick={() => {
                  setExpanded(open ? undefined : pkg.id);
                  setConfirmRemove(undefined);
                }}
              >
                <ExtensionAvatar name={manifest.extension.name} />
                <span>
                  <strong>{manifest.extension.name}</strong>
                  <small>
                    v{manifest.extension.version}
                    {sourceCount > 1 && ` · 소스 ${sourceCount}개`}
                    {failed && <em> · 실행 오류</em>}
                  </small>
                </span>
                <ChevronDown size={18} className="un-ext-chevron" aria-hidden="true" />
              </button>
              <Switch
                label={`${manifest.extension.name} 사용`}
                checked={pkg.enabled}
                onChange={(checked) =>
                  void run(() => manager.change(pkg.id, pkg.revision, checked ? 'enable' : 'disable'), '확장 전환')
                }
              />
            </div>
            {failed && (
              <p className="un-ext-trust is-warn">
                <AlertTriangle size={16} aria-hidden="true" />
                확장을 실행하지 못했어요. 새 버전을 설치하거나 이전 버전으로 되돌려 주세요.
              </p>
            )}
            {open && (
              <div className="un-ext-item-body">
                <code className="un-ext-id">{manifest.extension.id}</code>
                {manifest.extension.contributes?.externalSources?.map((source) => (
                  <InstalledSourcePreferences
                    key={source.id}
                    manager={manager}
                    sourceId={source.id}
                    title={`${source.title} · 확장 옵션`}
                    disabled={busy}
                  />
                ))}
                {manifest.requestedAccess.contentServices?.map((service) => (
                  <InstalledSourceContentConnection
                    key={`content:${pkg.revision}:${service.sourceId}`}
                    manager={manager}
                    sourceId={service.sourceId}
                    disabled={busy || !pkg.enabled}
                  />
                ))}
                {manifest.requestedAccess.authentication?.map((auth) => (
                  <InstalledSourceAuthentication
                    key={`${pkg.revision}:${auth.sourceId}`}
                    manager={manager}
                    auth={auth}
                    disabled={busy || !pkg.enabled}
                  />
                ))}
                <div className="un-ext-item-actions">
                  {manage && manifest.updates && manager.checkUpdate && (
                    <button
                      type="button"
                      className="un-btn is-ghost is-sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async (signal) => {
                          setReview(undefined);
                          setReviewLocation('installed:' + pkg.id);
                          setAcceptedChange(false);
                          const update = await manager.checkUpdate!(pkg.id, pkg.revision, signal);
                          if (update) setReview(update);
                          else setMessage('새 버전이 없어요.');
                        }, '업데이트 확인')
                      }
                    >
                      업데이트 확인
                    </button>
                  )}
                  {manage && pkg.previous && (
                    <button
                      type="button"
                      className="un-btn is-ghost is-sm"
                      disabled={busy}
                      onClick={() => void run(() => manager.change(pkg.id, pkg.revision, 'rollback'), '이전 버전 복원')}
                    >
                      이전 버전 복원
                    </button>
                  )}
                  {!manage ? null : confirmRemove === pkg.id ? (
                    <span className="un-ext-confirm">
                      <small>받은 작품은 그대로 남아요.</small>
                      <button
                        type="button"
                        className="un-btn is-text is-sm"
                        onClick={() => setConfirmRemove(undefined)}
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        className="un-btn is-sm un-ext-danger"
                        disabled={busy}
                        onClick={() => void run(() => manager.change(pkg.id, pkg.revision, 'remove'), '확장 제거')}
                      >
                        제거
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="un-btn is-text is-sm un-ext-remove"
                      disabled={busy}
                      onClick={() => setConfirmRemove(pkg.id)}
                    >
                      제거…
                    </button>
                  )}
                </div>
                {reviewLocation === 'installed:' + pkg.id && reviewCard}
              </div>
            )}
          </article>
        );
      })}
      {manager.mangayomi && mangayomiSources > 0 && (
        <button type="button" className="un-ext-link" onClick={() => openKind('mangayomi', { installed: true })}>
          <span className="un-ext-kind-icon is-js">JS</span>
          <span>
            <strong>Mangayomi JS 확장</strong>
            <small>소스 {mangayomiSources}개 · 켜기·끄기와 옵션</small>
          </span>
          <ChevronDown size={18} className="un-ext-chevron is-right" aria-hidden="true" />
        </button>
      )}
      {manager.apk && apkSources > 0 && (
        <button type="button" className="un-ext-link" onClick={() => openKind('apk', { installed: true })}>
          <span className="un-ext-kind-icon is-apk">APK</span>
          <span>
            <strong>APK 확장</strong>
            <small>소스 {apkSources}개 · 켜기·끄기와 옵션</small>
          </span>
          <ChevronDown size={18} className="un-ext-chevron is-right" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  return (
    <section className="un-ext" aria-label="콘텐츠 소스 패키지">
      {sourceTarget && onSourceTargetChange && (
        <div className="un-ext-target">
          <span>설치 위치</span>
          <Segmented
            label="소스 설치 위치"
            value={sourceTarget}
            options={[
              { value: 'device', label: '이 PC' },
              { value: 'server', label: '연결한 서버' },
            ]}
            onChange={onSourceTargetChange}
          />
        </div>
      )}

      <header className="un-ext-head">
        <div>
          <h3>확장</h3>
          <p>
            {where === '서버' ? <Server size={14} aria-hidden="true" /> : <Monitor size={14} aria-hidden="true" />}
            {where}에 설치 ·{' '}
            {snapshot.available
              ? enabledTotal === installedTotal
                ? `${installedTotal}개 사용 중`
                : `${installedTotal}개 중 ${enabledTotal}개 사용 중`
              : '확인 중'}
            {snapshot.errors.length > 0 && <em> · 오류 {snapshot.errors.length}</em>}
          </p>
        </div>
        <button
          type="button"
          className="un-icon-btn"
          disabled={busy}
          aria-label="설치된 확장 새로고침"
          title="새로고침"
          onClick={() => void run(() => manager.refresh(), '목록 새로고침')}
        >
          <RefreshCw size={18} className={cx(busy && 'un-ext-spin')} />
        </button>
        {manage && (
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            disabled={busy || !snapshot.available}
            onClick={() => fileInput.current?.click()}
          >
            <FilePlus2 size={16} aria-hidden="true" /> 파일로 설치
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".boaaext,.moyaext"
          hidden
          aria-label="확장 패키지 파일"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            setReview(undefined);
            setReviewLocation(undefined);
            setAcceptedChange(false);
            void run(async (signal) => {
              setReview({ file, plan: await manager.inspect(file, signal) });
            }, '확장 파일 확인');
          }}
        />
      </header>

      {!manage && (
        <Notice>
          관리자가 허용한 소스를 쓸 수 있어요. 켜고 끄기, 로그인, 옵션은 내 계정에만 적용돼요. 소스를 더 쓰고 싶으면
          관리자에게 부탁해 주세요.
        </Notice>
      )}

      {manage && (
        <Segmented
          label="확장 보기"
          value={tab}
          options={[
            { value: 'installed', label: installedTotal ? `설치됨 ${installedTotal}` : '설치됨' },
            { value: 'add', label: '추가하기' },
            { value: 'updates', label: '업데이트' },
          ]}
          onChange={(next) => {
            setTab(next);
            setInstalledView(false);
          }}
        />
      )}

      {!manage && tab === 'add' && (
        <button type="button" className="un-btn is-text is-sm un-ext-back" onClick={() => setTab('installed')}>
          ← 허용된 소스 목록
        </button>
      )}

      {status}
      {!reviewLocation && reviewCard}

      {tab === 'installed' &&
        (installedTotal || !snapshot.available
          ? installedList
          : !review &&
            (!manage ? (
              <Empty icon={<PackageOpen size={26} />} title="아직 허용된 소스가 없어요">
                <p>관리자가 소스를 허용하면 여기에 나타나고, 탐색에서 쓸 수 있어요.</p>
              </Empty>
            ) : (
              <Empty icon={<PackageOpen size={26} />} title="아직 설치한 확장이 없어요">
                <p>저장소 주소를 넣거나 확장 파일을 고르면 탐색에서 쓸 소스가 생겨요.</p>
                <button type="button" className="un-btn is-primary is-sm" onClick={() => setTab('add')}>
                  <ListPlus size={16} aria-hidden="true" /> 확장 추가하기
                </button>
              </Empty>
            )))}

      {tab === 'add' && (
        <div className="un-ext-add">
          {manage && kinds.length > 1 && (
            <div className="un-ext-kinds" role="tablist" aria-label="확장 형식">
              {kinds.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={value === activeKind}
                  className={cx('un-chip', value === activeKind && 'is-active')}
                  onClick={() => openKind(value)}
                >
                  {KIND_LABEL[value]}
                </button>
              ))}
            </div>
          )}
          {manage && activeKind === 'boaa' && (
            <UiNextRepositoryCatalog
              manager={manager}
              snapshot={snapshot}
              disabled={busy || !snapshot.available}
              onMangayomiRepository={
                manager.mangayomi ? (url) => openKind('mangayomi', { repository: url }) : undefined
              }
              onApkRepository={
                manager.apk || suwayomi
                  ? (url) => openKind(manager.apk ? 'apk' : 'suwayomi', { repository: url })
                  : undefined
              }
              renderReview={(id) => (reviewLocation === id ? reviewCard : null)}
              onReview={(value) => {
                setReviewLocation(value.plan.package.manifest.extension.id);
                setReview(value);
                setAcceptedChange(false);
                setError(undefined);
              }}
            />
          )}
          {activeKind === 'mangayomi' && manager.mangayomi && (
            <ApkExtensionsPanel
              key={`mangayomi:${installedView}:${routedRepository?.url ?? ''}`}
              manager={manager.mangayomi}
              format="mangayomi-js"
              target={manager.target}
              initialInstalledOnly={installedView}
              manage={manage}
              initialRepository={routedRepository?.kind === 'mangayomi' ? routedRepository.url : undefined}
              autoAddInitialRepository
            />
          )}
          {activeKind === 'apk' && manager.apk && (
            <ApkExtensionsPanel
              key={`apk:${installedView}:${routedRepository?.url ?? ''}`}
              manager={manager.apk}
              target={manager.target}
              initialInstalledOnly={installedView}
              manage={manage}
              initialRepository={routedRepository?.kind === 'apk' ? routedRepository.url : undefined}
              autoAddInitialRepository
            />
          )}
          {manage && activeKind === 'suwayomi' && suwayomi && (
            <SourceExtensionManagerPanel
              manager={suwayomi}
              initialRepository={routedRepository?.kind === 'suwayomi' ? routedRepository.url : undefined}
            />
          )}
          {!kinds.length && (
            <Empty icon={<ListPlus size={26} />} title="저장소를 쓸 수 없는 환경이에요">
              <p>위의 ‘파일로 설치’로 .boaaext 파일을 직접 설치할 수 있어요.</p>
            </Empty>
          )}
        </div>
      )}

      {manage && tab === 'updates' && (
        <ExtensionUpdatesPanel manager={manager} suwayomi={suwayomi} autoCheck={updatesRequest > 0} />
      )}

      {manage && (
        <details className="un-ext-advanced">
          <summary>
            고급
            <small>소스 보관소 · 연결 방식 · 기본 프록시</small>
            <ChevronDown size={18} className="un-ext-chevron" aria-hidden="true" />
          </summary>
          <PortableSourceVault manager={manager} />
          <SourceNetworkSettings manager={manager} />
        </details>
      )}
    </section>
  );
}
