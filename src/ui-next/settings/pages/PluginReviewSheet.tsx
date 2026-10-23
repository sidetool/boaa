import type { PlatformManifest } from '@boaa/extension-contracts/platform-package';
import { AppWindow, BookOpen, Code2, Database, Globe, House, type LucideIcon } from 'lucide-react';
import {
  pluginCapabilities,
  pluginCapabilityWarnings,
  pluginConnectionAccess,
  pluginHomeSectionTitles,
  type PluginCapabilityId,
} from '../../../extensions/platform/plugin-presentation';
import type { ProductPluginSession } from '../../../extensions/platform/product-session';
import type { usePlatformPluginSettingsModel } from '../../../extensions/platform/use-platform-plugin-settings-model';
import { Sheet } from '../../components/primitives';
import { Notice, PrefFold, PrefGroup, PrefSwitch } from '../../components/prefs';

const CAPABILITY_ICON: Record<PluginCapabilityId, LucideIcon> = {
  home: House,
  network: Globe,
  reader: BookOpen,
  data: Database,
  interface: AppWindow,
};

/** Compact capability summary for an installed plugin card. */
export function PluginCapabilityChips({ manifest }: { manifest: PlatformManifest }) {
  return (
    <ul className="un-plugin-chips" aria-label="하는 일">
      {pluginCapabilities(manifest).map((group) => {
        const Icon = CAPABILITY_ICON[group.id];
        return (
          <li key={group.id}>
            <Icon size={13} aria-hidden="true" />
            {group.title}
          </li>
        );
      })}
    </ul>
  );
}

function HomeSections({ manifest, replacing }: { manifest: PlatformManifest; replacing: boolean }) {
  const titles = pluginHomeSectionTitles(manifest);
  if (!titles.length) return null;
  return (
    <section className="un-plugin-review-block">
      <h3>{replacing ? '홈 목록' : '홈에 추가되는 목록'}</h3>
      <ul className="un-plugin-home-preview">
        {titles.map((title) => (
          <li key={title}>
            <House size={15} aria-hidden="true" />
            {title}
          </li>
        ))}
      </ul>
      <p className="un-plugin-muted">
        작품을 누르면 그 제목으로 검색해요. 순서와 숨기기는 홈 화면 편집에서 바꿀 수 있어요.
      </p>
    </section>
  );
}

export function PluginReviewSheet({
  model,
  session,
}: {
  model: ReturnType<typeof usePlatformPluginSettingsModel>;
  session: ProductPluginSession;
}) {
  const review = model.review;
  if (!review) return null;
  const { manifest } = review;
  const replacing = review.expectedRevision > 0;
  const close = () => model.setReview(undefined);
  return (
    <Sheet
      open
      onClose={close}
      closeDisabled={model.busy}
      title={replacing ? '바뀌는 내용 확인' : '설치 전 확인'}
      footer={
        <>
          <button type="button" className="un-btn is-ghost" disabled={model.busy} onClick={close}>
            취소
          </button>
          <button
            type="button"
            className="un-btn is-primary"
            disabled={model.busy || session.off}
            onClick={() => model.run(model.approve)}
          >
            {replacing ? '확인하고 적용' : '확인하고 설치'}
          </button>
        </>
      }
    >
      <div className="un-plugin-review">
        <header className="un-plugin-review-head">
          <span className="un-ext-icon" aria-hidden="true">
            <Code2 size={20} />
          </span>
          <div>
            <strong>{manifest.extension.name}</strong>
            <small>
              v{manifest.extension.version} · {review.publisher ? `서명: ${review.publisher}` : '서명 없음'}
            </small>
          </div>
        </header>
        {!review.publisher && (
          <Notice tone="warning">서명되지 않은 파일이에요. 믿을 수 있는 곳에서 받은 파일만 설치하세요.</Notice>
        )}
        {review.publisherChanged && <Notice tone="warning">서명한 사람이 바뀌어요.</Notice>}
        {review.sourceChanged && <Notice tone="warning">파일을 받은 곳이 바뀌어요.</Notice>}
        {review.downgrade && <Notice tone="warning">이전 버전으로 되돌려요.</Notice>}
        {review.sameVersionReplacement && <Notice tone="warning">같은 버전 이름으로 코드가 바뀌어요.</Notice>}

        <HomeSections manifest={manifest} replacing={replacing} />

        <section className="un-plugin-review-block">
          <h3>허용할 기능</h3>
          <p className="un-plugin-muted">{replacing ? '적용하면' : '설치하면'} 다음 기능에 필요한 권한을 허용합니다.</p>
          <ul className="un-plugin-capabilities">
            {pluginCapabilities(manifest).map((group) => {
              const Icon = CAPABILITY_ICON[group.id];
              return (
                <li key={group.id} className="un-plugin-role">
                  <span className="un-plugin-role-icon" aria-hidden="true">
                    <Icon size={17} />
                  </span>
                  <div>
                    <h4>{group.title}</h4>
                    {group.details.map((detail) => (
                      <p key={detail}>{detail}</p>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {pluginCapabilityWarnings(manifest).map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
        </section>

        {Boolean(manifest.connections?.length) && (
          <section className="un-plugin-review-block">
            <h3>연결할 외부 서비스</h3>
            <ul className="un-plugin-endpoints">
              {manifest.connections!.map((connection) => (
                <li key={connection.id}>
                  <strong>{connection.title}</strong>
                  <code>{connection.endpoint}</code>
                  <small>
                    {pluginConnectionAccess(connection.methods)} · {connection.methods.join(', ')}
                  </small>
                </li>
              ))}
            </ul>
            <p className="un-plugin-muted">요청은 BOAA 서버를 거쳐 나가요. 키가 필요하면 설치 후 설정에서 넣어요.</p>
          </section>
        )}

        {replacing && (
          <PrefGroup>
            <PrefSwitch
              title="지금 설정과 저장 자료 그대로 두기"
              help={
                model.preserve
                  ? '기존 설정을 새 버전에 맞춰 옮겨요.'
                  : '허락하면 이 플러그인의 설정과 저장 자료를 지워요.'
              }
              checked={model.preserve}
              disabled={review.publisherChanged || review.sourceChanged}
              onChange={model.setPreserve}
            />
          </PrefGroup>
        )}

        <PrefFold title="기술 정보">
          <dl className="un-plugin-facts">
            <div>
              <dt>ID</dt>
              <dd>{review.pluginId}</dd>
            </div>
            <div>
              <dt>실행 시점</dt>
              <dd>{manifest.activation.join(', ')}</dd>
            </div>
            <div>
              <dt>저장 공간</dt>
              <dd>{manifest.requestedAccess.storageKiB} KiB</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <code>{review.digest}</code>
              </dd>
            </div>
          </dl>
        </PrefFold>
      </div>
    </Sheet>
  );
}
