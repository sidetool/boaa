import type { ExtensionContributionId, ExtensionPermission } from '@boaa/extension-contracts';
import { Blocks, Puzzle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AppExtensionSnapshot, ExtensionContributionKind } from '../../../extensions/app-extension-manager';
import { Switch } from '../../components/primitives';
import { EmptyState, Notice, PrefSection } from '../../components/prefs';
import { PluginsSection } from './PluginsSection';

const PERMISSION: Record<ExtensionPermission, string> = {
  'analysis.workflow.execute': '앱이 주는 AI 기능 쓰기',
  'app.command.execute': '앱 명령 등록',
  'book.enrichment.propose': '작품 정보·표지 후보 제안',
  'external.source.download': '고른 외부 원문 가져오기',
  'external.source.list': '외부 작품·파일 목록 보기',
  'reader.addon.render': '리더 보조 패널 표시',
  'reader.context.read': '지금 읽는 책 정보 쓰기',
};

const CONTRIBUTION: Record<ExtensionContributionKind, string> = {
  reader_addon: '리더 패널',
  command: '명령',
  analysis: 'AI 기능',
  book_enrichment: '작품 정보 보강',
  external_source: '외부 소스',
};

function state(extension: AppExtensionSnapshot) {
  if (extension.trustLevel === 'sandboxed' && extension.state === 'failed') return '지원 안 함';
  if (extension.state === 'failed') return '실행 실패';
  return undefined;
}

function ExtensionCard({
  extension,
  setEnabled,
  details,
}: {
  extension: AppExtensionSnapshot;
  setEnabled(id: ExtensionContributionId, enabled: boolean): void;
  details?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const failed = state(extension);
  return (
    <article className="un-ext-card">
      <header className="un-ext-head">
        <span className="un-ext-icon" aria-hidden="true">
          <Puzzle size={18} />
        </span>
        <div className="un-ext-title">
          <strong>
            {extension.name}
            {extension.beta && <em>베타</em>}
          </strong>
          <small>
            v{extension.version}
            {extension.trustLevel !== 'trusted' && ' · 격리 실행은 아직 안 돼요'}
            {failed && ` · ${failed}`}
          </small>
        </div>
        <Switch
          label={`${extension.name} ${extension.enabled ? '끄기' : '켜기'}`}
          checked={extension.enabled}
          disabled={!extension.canDisable}
          onChange={(on) => setEnabled(extension.id, on)}
        />
      </header>
      {extension.description && <p className="un-ext-desc">{extension.description}</p>}
      {extension.errorMessage && <Notice tone="danger">{extension.errorMessage}</Notice>}
      <button type="button" className="un-ext-more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? '접기' : '하는 일과 권한'}
      </button>
      {open && (
        <dl className="un-ext-facts">
          <div>
            <dt>하는 일</dt>
            {extension.contributions.map((item) => (
              <dd key={item.id}>
                {CONTRIBUTION[item.kind]} · {item.title}
              </dd>
            ))}
          </div>
          <div>
            <dt>쓰는 권한</dt>
            {extension.permissions.length ? (
              extension.permissions.map((permission) => <dd key={permission}>{PERMISSION[permission]}</dd>)
            ) : (
              <dd>없음</dd>
            )}
          </div>
        </dl>
      )}
      {details && extension.enabled && <div className="un-ext-details">{details}</div>}
    </article>
  );
}

/** 기능 확장: features built into BOAA, community features, and JS plugins installed for this account. */
export function ExtensionsPage({
  extensions,
  setEnabled,
  renderDetails,
}: {
  extensions: readonly AppExtensionSnapshot[];
  setEnabled(id: ExtensionContributionId, enabled: boolean): void;
  renderDetails(extension: AppExtensionSnapshot): ReactNode;
}) {
  const bundled = extensions.filter((extension) => extension.origin === 'bundled');
  const community = extensions.filter((extension) => extension.origin === 'community');
  return (
    <>
      <PrefSection title="기본 기능" hint="BOAA에 들어 있는 기능이에요. 필요 없으면 꺼 두세요.">
        <div className="un-ext-list">
          {bundled.map((extension) => (
            <ExtensionCard
              key={extension.id}
              extension={extension}
              setEnabled={setEnabled}
              details={renderDetails(extension)}
            />
          ))}
        </div>
      </PrefSection>

      <PrefSection title="커뮤니티 기능">
        {community.length ? (
          <div className="un-ext-list">
            {community.map((extension) => (
              <ExtensionCard
                key={extension.id}
                extension={extension}
                setEnabled={setEnabled}
                details={renderDetails(extension)}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={<Blocks size={22} />} title="설치한 커뮤니티 기능이 없어요" />
        )}
      </PrefSection>

      <PluginsSection />
    </>
  );
}
