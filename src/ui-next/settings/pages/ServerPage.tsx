import {
  AppWindow,
  Check,
  CircleAlert,
  Cpu,
  Download,
  ExternalLink,
  LoaderCircle,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ServerCog,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import packageMetadata from '../../../../package.json';
import type {
  ManagementPhase,
  OptionalComponentId,
  ReleaseChannel,
  ServerComponent,
} from '../../../../packages/contracts/server-management';
import type { ServerManagementClient } from '../../../features/server-management/server-management-client';
import { useServerManagementClient } from '../../../features/server-management/use-server-management-client';
import {
  displayVersion,
  formatCheckedAt,
  formatDownloadSize,
} from '../../../features/server-management/server-versions';
import {
  managementErrorMessage,
  RELEASE_GUIDE,
  RUNTIME_GUIDE,
} from '../../../features/server-management/server-management-messages';
import {
  useServerManagement,
  type ActionNotice,
  type PendingRequest,
  type ServerManagementModel,
} from '../../../features/server-management/use-server-management';
import { ConfirmSheet } from '../../components/dialogs';
import { cx } from '../../components/primitives';
import {
  EmptyState,
  Notice,
  PrefFold,
  PrefGroup,
  PrefOptions,
  PrefSection,
  PrefSkeleton,
} from '../../components/prefs';

interface ComponentInfo {
  title: string;
  /** The name with its object particle, for questions like "…를 멈출까요?". */
  object: string;
  help: string;
  stopEffect: string;
  /** Something the server admin must provide outside the app before this runtime does anything. */
  requirement?: string;
  icon: ReactNode;
}

const COMPONENTS: Record<OptionalComponentId, ComponentInfo> = {
  apk: {
    title: 'APK 확장 실행기',
    object: 'APK 확장 실행기를',
    help: 'Android용 소스 확장을 서버에서 실행해요. Java 실행 환경이 함께 설치돼요.',
    stopEffect: 'APK 소스는 다시 켤 때까지 열리지 않아요.',
    icon: <Package size={18} />,
  },
  browser: {
    title: '브라우저 실행 환경',
    object: '브라우저 실행 환경을',
    help: '로그인이 필요하거나 브라우저로만 열리는 소스, 작품 정보 인증에 써요.',
    stopEffect: '브라우저가 필요한 소스와 작품 정보 인증은 다시 켤 때까지 멈춰요. HTTP 소스는 계속 열려요.',
    icon: <AppWindow size={18} />,
  },
  metadata: {
    title: '작품 정보 수집기',
    object: '작품 정보 수집기를',
    help: '서재 작품의 소개·표지·태그를 서버에서 채워요.',
    stopEffect: '작품 정보 보강은 다시 켤 때까지 멈춰요. 제공자와 캐시는 남아요.',
    requirement: `실제로 정보를 가져오는 제공자는 앱에 들어 있지 않아요. 서버 관리자가 설치 폴더의 ${RELEASE_GUIDE}(‘선택 구성요소’)와 ${RUNTIME_GUIDE} 안내대로 제공자 폴더를 따로 연결해야 수집이 시작돼요.`,
    icon: <ScanSearch size={18} />,
  },
};
const COMPONENT_ORDER: readonly OptionalComponentId[] = ['apk', 'browser', 'metadata'];

/** The steps of an update as the person sees them; the server phases map onto these. */
const UPDATE_STEPS: readonly { label: string; phases: readonly ManagementPhase[] }[] = [
  { label: '받기', phases: ['downloading'] },
  { label: '사전 점검', phases: ['preflight'] },
  { label: '백업', phases: ['backup'] },
  { label: '적용', phases: ['applying'] },
  { label: '확인', phases: ['verifying'] },
];

const PHASE_LABEL: Partial<Record<ManagementPhase, string>> = {
  checking: '새 버전을 확인하고 있어요',
  downloading: '새 버전을 받고 있어요',
  preflight: '진행 중인 작업을 정리하고 있어요',
  backup: '데이터를 백업하고 있어요',
  applying: '새 버전으로 바꾸고 있어요',
  verifying: '서버가 정상인지 확인하고 있어요',
  'rolling-back': '문제가 생겨 이전 버전으로 되돌리고 있어요',
};

type ComponentState = 'unsupported' | 'external' | 'queued' | 'working' | 'error' | 'setup' | 'absent' | 'on' | 'off';

/** Runtime error codes in words: cause and next step. Unknown codes stay generic so helper text never leaks. */
function componentErrorMessage(code: string): string {
  if (code === 'component_provider_missing')
    return `실행기는 준비됐지만 작품 정보 제공자가 아직 연결되지 않아 수집은 멈춰 있어요. 서버 관리자가 설치 폴더의 ${RELEASE_GUIDE}(‘선택 구성요소’)와 ${RUNTIME_GUIDE} 안내대로 제공자 폴더를 연결하면 바로 쓸 수 있어요.`;
  return managementErrorMessage(code, 'component').text;
}

function componentState(component: ServerComponent, model: ServerManagementModel): ComponentState {
  if (!component.supported) return 'unsupported';
  if (!component.managed) return 'external';
  const operation = model.status?.operation;
  if (model.pending === `component:${component.id}`) return model.pendingStage === 'running' ? 'working' : 'queued';
  if (
    model.active &&
    operation?.action === 'component' &&
    operation.componentId === component.id &&
    !operation.completedAt
  )
    return 'working';
  // Running fine but waiting on server-side configuration that retrying cannot fix.
  if (component.error === 'component_provider_missing' && component.installed && component.enabled) return 'setup';
  if (component.error) return 'error';
  if (!component.installed) return 'absent';
  return component.enabled ? 'on' : 'off';
}

const STATE_LABEL: Record<ComponentState, string> = {
  unsupported: '이 서버에서 못 써요',
  external: '직접 관리 중',
  queued: '대기 중',
  working: '처리 중',
  error: '오류',
  setup: '설정 필요',
  absent: '설치 안 됨',
  on: '사용 중',
  off: '중지됨',
};

export type ComponentChange = 'install' | 'enable' | 'stop' | 'retry';

function ComponentRow({
  component,
  model,
  onChange,
}: {
  component: ServerComponent;
  model: ServerManagementModel;
  onChange(component: ServerComponent, change: ComponentChange): void;
}) {
  const info = COMPONENTS[component.id];
  const state = componentState(component, model);
  const blocked = Boolean(model.pending) || model.active || model.reconnecting || model.recoveryRequired;
  const ours = model.pending === `component:${component.id}`;
  const stopping = ours ? model.pendingEnabled === false : model.status?.operation?.enabled === false;
  const installing = (state === 'working' || state === 'queued') && !component.installed;
  const size = component.downloadBytes ? formatDownloadSize(component.downloadBytes) : undefined;
  const meta = [
    component.version && displayVersion(component.version),
    state === 'on' && (component.running ? '지금 실행 중' : '필요할 때 시작'),
    (state === 'absent' || installing) && size && `받을 용량 ${size}`,
  ].filter(Boolean);
  const notice = model.actionError?.key === `component:${component.id}` ? model.actionError : undefined;
  const button = (change: ComponentChange, icon: ReactNode, label: string) => (
    <button
      key={change}
      type="button"
      className="un-btn is-ghost is-sm"
      disabled={blocked}
      onClick={() => onChange(component, change)}
    >
      {icon}
      {label}
    </button>
  );
  const stop = button('stop', <Square size={13} aria-hidden="true" />, '중지');

  let action: ReactNode = null;
  if (state === 'queued' || state === 'working') {
    action = (
      <span className="un-server-working">
        <LoaderCircle size={15} className="un-spin" aria-hidden="true" />
        {state === 'queued' ? '요청 보냄' : installing ? '설치 중' : stopping ? '중지하는 중' : '적용 중'}
      </span>
    );
  } else if (state === 'absent') {
    action = button('install', <Download size={15} aria-hidden="true" />, '설치');
  } else if (state === 'error') {
    // A failing runtime that is switched on can still be stopped; retrying is not the only way out.
    action = (
      <>
        {button('retry', <RotateCcw size={15} aria-hidden="true" />, '다시 시도')}
        {component.installed && component.enabled && stop}
      </>
    );
  } else if (state === 'on' || state === 'setup') {
    action = stop;
  } else if (state === 'off') {
    action = button('enable', <Play size={14} aria-hidden="true" />, '켜기');
  }

  return (
    <div className={cx('un-pref un-server-component', `is-${state}`)}>
      <span className="un-server-component-icon" aria-hidden="true">
        {info.icon}
      </span>
      <div className="un-pref-text">
        <strong>
          {info.title}
          <span className={cx('un-server-state', `is-${state}`)}>{STATE_LABEL[state]}</span>
        </strong>
        <small>{info.help}</small>
        {meta.length > 0 && <small className="un-server-meta">{meta.join(' · ')}</small>}
        {info.requirement && (state === 'absent' || state === 'off') && (
          <small className="un-server-meta">{info.requirement}</small>
        )}
        {state === 'queued' && (
          <small className="un-server-meta">updater가 요청을 받으면 시작해요. 서버가 잠시 다시 시작될 수 있어요.</small>
        )}
        {state === 'external' && (
          <small className="un-server-meta">서버 설정에서 직접 관리하고 있어서 여기서 바꿀 수 없어요.</small>
        )}
        {(state === 'error' || state === 'setup') && component.error && (
          <small className={state === 'setup' ? 'un-server-warning' : 'un-server-error'} role="alert">
            {componentErrorMessage(component.error)}
          </small>
        )}
        {notice && (
          <small className={notice.tone === 'danger' ? 'un-server-error' : 'un-server-warning'} role="alert">
            {notice.text}
            {notice.unresolved && (
              <button
                type="button"
                className="un-btn is-text is-sm un-server-recheck"
                onClick={() => void model.refresh()}
              >
                다시 확인
              </button>
            )}
          </small>
        )}
      </div>
      {action && <div className="un-pref-control un-server-actions">{action}</div>}
    </div>
  );
}

/** A request outcome in the card or section it belongs to. Unknown outcomes offer a fresh look, not a verdict. */
function ActionNoticeView({ notice, model }: { notice: ActionNotice; model: ServerManagementModel }) {
  return (
    <Notice
      tone={notice.tone}
      action={
        notice.unresolved ? (
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            onClick={() => {
              model.dismissError();
              void model.refresh();
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            다시 확인
          </button>
        ) : undefined
      }
    >
      {notice.text}
    </Notice>
  );
}

function noticeFor(model: ServerManagementModel, ...keys: PendingRequest[]) {
  const notice = model.actionError;
  return notice && keys.includes(notice.key) ? notice : undefined;
}

function UpdateProgress({ phase }: { phase: ManagementPhase }) {
  const current = UPDATE_STEPS.findIndex((step) => step.phases.includes(phase));
  return (
    <ol className="un-server-steps" aria-label="업데이트 진행 단계">
      {UPDATE_STEPS.map((step, index) => {
        const done = current > index;
        const now = current === index;
        return (
          <li
            key={step.label}
            className={cx(done && 'is-done', now && 'is-now')}
            aria-current={now ? 'step' : undefined}
          >
            <span aria-hidden="true">
              {done ? <Check size={12} /> : now ? <LoaderCircle size={12} className="un-spin" /> : index + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Whether the most recent release check failed: this screen's own failed check, else the newest `check` in the
 * server's history (server timestamps compared only with each other), else the current operation.
 */
function lastCheckFailed(model: ServerManagementModel): boolean {
  const status = model.status;
  if (!status) return false;
  const own = model.actionError;
  if (own?.key === 'check' && !own.unresolved) return true;
  const checks = (status.operationResults ?? []).filter((result) => result.action === 'check');
  const latest = checks.reduce<(typeof checks)[number] | undefined>(
    (newest, result) => (!newest || result.completedAt > newest.completedAt ? result : newest),
    undefined,
  );
  const operation = status.operation;
  if (operation?.action === 'check' && operation.completedAt && (!latest || operation.completedAt > latest.completedAt))
    return status.phase === 'failed';
  return latest ? latest.outcome !== 'complete' : false;
}

function ReleaseCard({ model, onUpdate }: { model: ServerManagementModel; onUpdate(): void }) {
  const status = model.status!;
  const release = status.release;
  const operation = status.operation;
  const restarting = model.reconnecting && model.pending === 'update';
  const updateRunning = model.active && (operation?.action === 'update' || status.phase === 'rolling-back');
  const updating = restarting || updateRunning || model.pending === 'update';
  const waiting = !model.active && !model.reconnecting && model.pendingStage !== 'running';
  const checking = model.pending === 'check' || (model.active && status.phase === 'checking');
  const notice = noticeFor(model, 'check', 'update');
  const failure =
    !updating && !notice && status.phase === 'failed'
      ? managementErrorMessage(status.error, operation?.action ?? 'update')
      : undefined;
  const blocked = Boolean(model.pending) || model.active || model.reconnecting || model.recoveryRequired;

  let headline: ReactNode;
  let detail: ReactNode = null;
  if (restarting) {
    headline = '서버를 다시 시작하는 중이에요';
    detail = model.slowReconnect
      ? '평소보다 오래 걸리고 있어요. 계속 연결을 시도할게요. 서버 관리 화면이나 로그를 확인해 보세요.'
      : '연결되면 자동으로 이어서 보여 드려요. 이 화면을 닫아도 업데이트는 계속돼요.';
  } else if (updating && waiting) {
    headline = model.pendingStage === 'sending' ? '업데이트 요청을 보내고 있어요' : '업데이트 요청을 보냈어요';
    detail = 'updater가 요청을 받으면 바로 시작해요. 시작되면 서재와 소스를 잠시 쓸 수 없어요.';
  } else if (updating) {
    headline = PHASE_LABEL[status.phase] ?? '업데이트하고 있어요';
    detail = '잠시 동안 서재와 소스를 쓸 수 없어요. 이 화면을 닫아도 업데이트는 계속돼요.';
  } else if (model.updated) {
    headline = `${displayVersion(status.currentVersion)} 업데이트를 마쳤어요`;
  } else if (checking) {
    headline = model.pending === 'check' && waiting ? '확인 요청을 보냈어요' : PHASE_LABEL.checking;
  } else if (model.updateAvailable && release) {
    headline = '새 버전이 나왔어요';
    detail = [displayVersion(release.version), release.publishedAt && `${formatCheckedAt(release.publishedAt)} 공개`]
      .filter(Boolean)
      .join(' · ');
  } else if (lastCheckFailed(model)) {
    // checkedAt may predate the failure; never call the server current on a check that did not finish.
    headline = '새 버전을 확인하지 못했어요';
    detail = '지금 버전이 최신인지는 아직 몰라요. 아래 안내를 확인한 뒤 다시 확인해 주세요.';
  } else if (status.checkedAt) {
    headline = '최신 버전이에요';
    detail = `${formatCheckedAt(status.checkedAt)} 확인`;
  } else {
    headline = '아직 새 버전을 확인하지 않았어요';
  }

  return (
    <div className={cx('un-server-card', model.updateAvailable && !updating && 'has-update')}>
      <div className="un-server-card-head">
        <span className="un-server-card-icon" aria-hidden="true">
          <ServerCog size={22} />
        </span>
        <div className="un-server-card-title">
          <small>BOAA 서버</small>
          <b>
            {displayVersion(status.currentVersion)}
            <span className={cx('un-server-channel', status.channel === 'beta' && 'is-beta')}>
              {status.channel === 'beta' ? '베타' : '정식'}
            </span>
          </b>
        </div>
      </div>

      <div className="un-server-card-status" role="status" aria-live="polite">
        <strong>{headline}</strong>
        {detail && <p>{detail}</p>}
      </div>

      {updateRunning && !model.reconnecting && status.phase !== 'rolling-back' && (
        <UpdateProgress phase={status.phase} />
      )}

      {failure && <Notice tone={failure.tone}>{failure.text}</Notice>}
      {status.phase === 'recovery-required' && (
        <Notice tone="danger">
          업데이트를 되돌리지 못해 서버 관리자의 복구가 필요해요. 복구가 끝날 때까지 업데이트와 추가 기능 변경을 막아
          둘게요. {RELEASE_GUIDE}의 ‘운영과 복구’와 updater 로그를 확인해 주세요.
        </Notice>
      )}
      {notice && <ActionNoticeView notice={notice} model={model} />}
      {(model.updated || (model.staleWeb && !updating)) && (
        <Notice
          tone={model.updated ? 'info' : 'warning'}
          action={
            <button type="button" className="un-btn is-ghost is-sm" onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              새로 고침
            </button>
          }
        >
          {model.updated
            ? '새 화면을 쓰려면 페이지를 새로 고쳐 주세요.'
            : `이 화면(${displayVersion(packageMetadata.version)})이 서버와 버전이 달라요. 새로 고치면 맞춰져요.`}
        </Notice>
      )}

      {!updating && (
        <div className="un-server-card-actions">
          {model.updateAvailable && (
            <button type="button" className="un-btn is-primary is-sm" disabled={blocked} onClick={onUpdate}>
              <Download size={15} aria-hidden="true" />
              업데이트
            </button>
          )}
          <button type="button" className="un-btn is-ghost is-sm" disabled={blocked} onClick={() => void model.check()}>
            {checking ? (
              <LoaderCircle size={15} className="un-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={15} aria-hidden="true" />
            )}
            업데이트 확인
          </button>
        </div>
      )}

      {release && model.updateAvailable && !updating && (
        <PrefFold title={`${displayVersion(release.version)} 변경 내역`} defaultOpen>
          <div className="un-server-notes">{release.notes.trim() || '변경 내역이 없어요.'}</div>
          {release.url && (
            <a
              className="un-btn is-text is-sm un-server-notes-link"
              href={release.url}
              target="_blank"
              rel="noreferrer"
            >
              GitHub에서 보기 <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </PrefFold>
      )}
    </div>
  );
}

function Unavailable({
  kind,
  reason,
  phase,
  retry,
}: {
  kind?: string;
  reason?: string;
  phase?: ManagementPhase;
  retry(): void;
}) {
  const again = (
    <button type="button" className="un-btn is-ghost is-sm" onClick={retry}>
      <RefreshCw size={15} aria-hidden="true" />
      다시 확인
    </button>
  );
  if (kind === 'forbidden')
    return (
      <EmptyState
        icon={<CircleAlert size={22} />}
        title="서버 관리자만 볼 수 있어요"
        body="관리자 계정으로 로그인하면 업데이트와 추가 기능을 관리할 수 있어요."
      />
    );
  if (reason === 'updater_unavailable' || kind === 'updater-unavailable')
    return (
      <>
        <EmptyState
          icon={<CircleAlert size={22} />}
          title="updater가 응답하지 않아요"
          body="이 서버에는 관리 도구가 설정돼 있지만 updater 서비스가 멈췄거나 응답하지 않아요. 서재는 그대로 쓸 수 있어요."
          action={again}
        />
        <Notice tone="warning">
          서버에서 updater 컨테이너가 실행 중인지와 로그를 확인해 주세요. 자세한 방법은 {RELEASE_GUIDE}의 ‘운영과
          복구’에 있어요.
        </Notice>
      </>
    );
  if (kind === 'offline' || kind === 'failed' || kind === 'conflict')
    return (
      <EmptyState
        icon={<CircleAlert size={22} />}
        title="서버 상태를 불러오지 못했어요"
        body="서버 연결을 확인한 뒤 다시 시도해 주세요."
        action={again}
      />
    );
  if (reason === 'update_recovery_required' || phase === 'recovery-required')
    return (
      <>
        <EmptyState
          icon={<TriangleAlert size={22} />}
          title="서버 복구가 필요해요"
          body="업데이트에 실패한 뒤 이전 버전으로 되돌리는 것도 끝내지 못해 화면에서의 관리를 멈췄어요."
          action={again}
        />
        <Notice tone="danger">
          서버에서 {RELEASE_GUIDE}의 ‘운영과 복구’ 절차대로 업데이트 전 백업과 이전 구성을 되살려 주세요. 복구가 끝나면
          이 화면에서 다시 확인할 수 있어요.
        </Notice>
      </>
    );
  if (reason === 'deployment_drift')
    return (
      <>
        <EmptyState
          icon={<TriangleAlert size={22} />}
          title="배포 구성이 저장된 상태와 달라요"
          body="실행 중인 컨테이너의 이미지, 환경값, 데이터 연결이 관리 도구가 기록한 구성과 달라 화면에서의 업데이트와 추가 기능 관리를 멈췄어요."
          action={again}
        />
        <Notice tone="warning">
          Compose 파일을 직접 다시 적용했을 때 주로 생겨요. 데이터를 지키기 위해 자동으로 맞추지 않으니, 서버에서
          {RELEASE_GUIDE}의 ‘운영과 복구’ 절차대로 구성을 맞춘 뒤 다시 확인해 주세요.
        </Notice>
      </>
    );
  // Server reasons are either readable sentences or codes; codes this screen does not know stay generic.
  const readable = reason && !/^[a-z0-9_]+$/.test(reason) ? reason : undefined;
  return (
    <>
      <EmptyState
        icon={<Cpu size={22} />}
        title="서버 관리 도구가 설정돼 있지 않아요"
        body={readable || '이 서버는 화면에서 업데이트하거나 추가 기능을 설치할 수 없게 설치돼 있어요.'}
        action={again}
      />
      <Notice>
        Docker로 설치했다면 배포 문서 {RELEASE_GUIDE}의 안내대로 updater 서비스(boaa-updater 이미지)를 함께 실행해
        주세요. 소스에서 직접 빌드한 서버는 지금처럼 명령줄로 업데이트해요.
      </Notice>
    </>
  );
}

const CHANGE_COPY: Record<ComponentChange, { title(object: string): string; confirm: string }> = {
  install: { title: (object) => `${object} 설치할까요?`, confirm: '설치' },
  enable: { title: (object) => `${object} 다시 켤까요?`, confirm: '켜기' },
  stop: { title: (object) => `${object} 멈출까요?`, confirm: '중지' },
  retry: { title: (object) => `${object} 다시 시작할까요?`, confirm: '다시 시도' },
};

/** Every runtime change restarts the API and its worker, so each one says so before it starts. */
function ComponentConfirm({
  change,
  onClose,
  onConfirm,
}: {
  change?: { component: ServerComponent; kind: ComponentChange };
  onClose(): void;
  onConfirm(component: ServerComponent, kind: ComponentChange): void;
}) {
  const info = change && COMPONENTS[change.component.id];
  const copy = change && CHANGE_COPY[change.kind];
  const size = change?.component.downloadBytes ? formatDownloadSize(change.component.downloadBytes) : undefined;
  return (
    <ConfirmSheet
      open={Boolean(change)}
      title={info && copy ? copy.title(info.object) : ''}
      confirmLabel={copy?.confirm ?? ''}
      onClose={onClose}
      onConfirm={() => {
        if (change) onConfirm(change.component, change.kind);
      }}
    >
      {change && info && (
        <>
          {change.kind === 'install' && size && <p>최대 {size}를 받아 설치해요.</p>}
          {change.kind === 'stop' && <p>{info.stopEffect}</p>}
          <p>
            적용하는 동안 서버가 잠시 다시 시작돼 서재와 소스 연결이 잠깐 끊겨요. 진행 중인 가져오기·다운로드가 있다면
            끝난 뒤에 하는 게 좋아요.
          </p>
          {info.requirement && change.kind !== 'stop' && <p>{info.requirement}</p>}
          <p>설치한 확장과 설정, 로그인 정보는 지우지 않아요.</p>
        </>
      )}
    </ConfirmSheet>
  );
}

/** 서버 관리: the server release, its channel and the optional runtimes it can install. Admin only. */
export function ServerPage({ client }: { client: ServerManagementClient }) {
  const model = useServerManagement(client, packageMetadata.version);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [change, setChange] = useState<{ component: ServerComponent; kind: ComponentChange }>();
  const status = model.status;

  if (model.loading && !status) return <PrefSkeleton rows={4} />;
  if (!status) return <Unavailable kind={model.loadError} retry={() => void model.refresh()} />;
  if (!status.available)
    return <Unavailable reason={status.reason} phase={status.phase} retry={() => void model.refresh()} />;

  const blocked = Boolean(model.pending) || model.active || model.reconnecting || model.recoveryRequired;
  const components = COMPONENT_ORDER.map((id) => status.components.find((component) => component.id === id)).filter(
    (component): component is ServerComponent => Boolean(component),
  );
  const release = status.release;

  return (
    <>
      {model.loadError && (
        <Notice tone="warning">최신 상태를 불러오지 못했어요. 마지막으로 받은 상태를 보여 주고 있어요.</Notice>
      )}
      {model.reconnecting && model.pending !== 'update' && (
        <Notice>추가 기능을 적용하는 동안 서버가 잠시 다시 시작돼요. 연결되면 자동으로 이어서 보여 드려요.</Notice>
      )}

      <PrefSection title="업데이트">
        <ReleaseCard model={model} onUpdate={() => setConfirmUpdate(true)} />
      </PrefSection>

      <PrefSection title="받을 버전" hint="바꿔도 바로 설치되지 않아요. 다음 확인부터 이 종류의 새 버전을 알려 드려요.">
        <PrefOptions<ReleaseChannel>
          label="받을 버전"
          value={status.channel}
          disabled={blocked}
          onChange={(channel) => {
            if (channel !== status.channel) void model.setChannel(channel);
          }}
          options={[
            { value: 'stable', label: '정식', hint: '충분히 확인한 버전만 받아요.' },
            { value: 'beta', label: '베타', hint: '새 기능을 먼저 받아요. 문제가 있을 수 있어요.' },
          ]}
        />
        {status.channel === 'stable' && status.currentVersion.includes('-') && (
          <Notice>지금 베타 버전이에요. 더 높은 정식 버전이 나오면 그때 받을 수 있어요.</Notice>
        )}
        {model.pending === 'channel' && (
          <p className="un-server-inline" role="status">
            <LoaderCircle size={14} className="un-spin" aria-hidden="true" /> 바꾸는 중…
          </p>
        )}
        {noticeFor(model, 'channel') && <ActionNoticeView notice={noticeFor(model, 'channel')!} model={model} />}
      </PrefSection>

      <PrefSection
        title="추가 기능"
        hint="필요한 것만 설치해 서버 용량과 메모리를 아껴요. 설치한 뒤에도 언제든 멈출 수 있어요."
      >
        {components.length ? (
          <PrefGroup>
            {components.map((component) => (
              <ComponentRow
                key={component.id}
                component={component}
                model={model}
                onChange={(target, kind) => setChange({ component: target, kind })}
              />
            ))}
          </PrefGroup>
        ) : (
          <EmptyState icon={<Package size={22} />} title="이 서버에서 설치할 수 있는 추가 기능이 없어요" />
        )}
        <Notice>
          추가 기능을 멈추거나 서버를 업데이트해도 설치한 확장, 소스 설정, 로그인 정보, 서재는 그대로 남아요.
        </Notice>
      </PrefSection>

      <ConfirmSheet
        open={confirmUpdate}
        title="서버를 업데이트할까요?"
        confirmLabel="업데이트"
        onClose={() => setConfirmUpdate(false)}
        onConfirm={() => void model.update()}
      >
        {release && (
          <p>
            {displayVersion(status.currentVersion)} → <b>{displayVersion(release.version)}</b>
          </p>
        )}
        <p>
          진행 중인 가져오기·다운로드를 정리하고, 데이터를 백업한 뒤 새 버전으로 바꿔요. 몇 분 동안 서재를 쓸 수 없어요.
        </p>
        <p>책, 독서 기록, 설정, 설치한 확장은 그대로 남아요. 문제가 생기면 이전 버전으로 되돌려요.</p>
      </ConfirmSheet>

      <ComponentConfirm
        change={change}
        onClose={() => setChange(undefined)}
        onConfirm={(target, kind) => void model.setComponent(target.id, kind !== 'stop')}
      />
    </>
  );
}

/** Settings tab entry: the tab is listed only when a server client exists, so this stays empty otherwise. */
export function ServerManagementPage() {
  const client = useServerManagementClient();
  return client ? <ServerPage client={client} /> : null;
}
