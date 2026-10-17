import {
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  Compass,
  Link,
  Link2Off,
  LoaderCircle,
  PlugZap,
  Search,
  Star,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExternalSourceConnectionStatus } from '../../../external-sources/contracts';
import type {
  ExternalSourceController,
  ExternalSourceView,
} from '../../../features/external-sources/external-source-controller-contract';
import { useExternalSourceSettingsModel } from '../../../features/external-sources/use-external-source-settings-model';
import { useSourceConnectionSettingsModel } from '../../../features/external-sources/use-source-connection-settings-model';
import { SourceExtensionManagerPanel } from '../../../features/extensions/SourceExtensionManagerPanel';
import type { ReaderSettingsController } from '../../../features/reader-settings/useReaderSettingsDraft';
import { cx } from '../../components/primitives';
import { EmptyState, Notice, PrefChips, PrefField, PrefFold, PrefSection, PrefSwitch } from '../../components/prefs';

const STATUS: Record<ExternalSourceConnectionStatus['state'], string> = {
  connected: '연결됨',
  disconnected: '연결 안 됨',
  reauthorization_required: '다시 연결 필요',
  unavailable: '쓸 수 없음',
};

function SourceRow({
  source,
  controller,
  favorite,
  toggleFavorite,
  onBrowse,
}: {
  source: ExternalSourceView;
  controller: ExternalSourceController;
  favorite: boolean;
  toggleFavorite(id: string): void;
  onBrowse?(id: ExternalSourceView['id']): void;
}) {
  const model = useSourceConnectionSettingsModel(source, controller);
  const { connection } = model;
  const Icon = model.unavailable ? CloudOff : source.kind === 'cloud_file' ? Cloud : PlugZap;
  const retry = model.needsReauthorization;
  const connectLabel = source.connectionForm?.submitLabel ?? (retry ? '다시 연결' : '연결');

  return (
    <li className={cx('un-srcset', model.active && 'is-open')}>
      <div className="un-srcset-row">
        <button
          type="button"
          className="un-srcset-main"
          aria-expanded={model.active}
          onClick={() => void model.select()}
        >
          <span className={cx('un-srcset-icon', `is-${connection.state}`)} aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="un-pref-text">
            <strong>{source.title}</strong>
            {source.description && <small>{source.description}</small>}
          </span>
          <span className={cx('un-srcset-status', `is-${connection.state}`)}>
            {model.connected && <Check size={12} />}
            {STATUS[connection.state]}
          </span>
          <ChevronDown size={17} className="un-srcset-chevron" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cx('un-icon-btn is-sm un-srcset-star', favorite && 'is-on')}
          aria-pressed={favorite}
          aria-label={`${source.title} 즐겨찾기`}
          onClick={() => toggleFavorite(source.id)}
        >
          <Star size={16} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      {model.active && (
        <div className="un-srcset-panel">
          {model.unavailable ? (
            <Notice tone="warning">{connection.reason ?? '지금 쓰는 환경에서는 이 소스를 쓸 수 없어요.'}</Notice>
          ) : model.connected ? (
            <>
              <p className="un-srcset-account">
                <span>연결된 계정</span>
                <strong>{connection.label ?? source.title}</strong>
              </p>
              <div className="un-srcset-actions">
                {onBrowse && (
                  <button type="button" className="un-btn is-primary is-sm" onClick={() => onBrowse(source.id)}>
                    <Compass size={15} />
                    작품 둘러보기
                  </button>
                )}
                <button
                  type="button"
                  className="un-btn is-ghost is-sm"
                  disabled={model.busy}
                  onClick={() => void model.disconnect()}
                >
                  {model.busy ? <LoaderCircle size={15} className="un-spin" /> : <Link2Off size={15} />}
                  연결 끊기
                </button>
              </div>
              {source.extensionManager && (
                <PrefFold title="확장 저장소 관리">
                  <div className="un-source-legacy">
                    <SourceExtensionManagerPanel manager={source.extensionManager} />
                  </div>
                </PrefFold>
              )}
            </>
          ) : (
            <form
              className="un-srcset-form"
              onSubmit={(event) => {
                event.preventDefault();
                void model.submitConnection();
              }}
            >
              {connection.reason && <Notice tone={retry ? 'warning' : 'info'}>{connection.reason}</Notice>}
              {source.connectionForm?.help && <p className="un-srcset-help">{source.connectionForm.help}</p>}
              {model.fields.map((field) => (
                <PrefField key={field.id} label={field.label} help={field.help}>
                  {field.type === 'select' ? (
                    <select
                      value={model.values[field.id] ?? ''}
                      required={field.required}
                      disabled={model.busy}
                      onChange={(event) =>
                        model.setValues((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                    >
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type}
                      value={model.values[field.id] ?? ''}
                      required={field.required}
                      disabled={model.busy}
                      placeholder={field.placeholder}
                      autoComplete={field.type === 'password' ? 'current-password' : 'off'}
                      onChange={(event) =>
                        model.setValues((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                    />
                  )}
                </PrefField>
              ))}
              <button type="submit" className="un-btn is-primary un-srcset-connect" disabled={model.busy}>
                {model.busy ? <LoaderCircle size={16} className="un-spin" /> : <Link size={16} />}
                {connectLabel}
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

function SourceList({
  title,
  sources,
  empty,
  ...rest
}: {
  title: string;
  sources: readonly ExternalSourceView[];
  empty: string;
  controller: ExternalSourceController;
  favorites: readonly string[];
  toggleFavorite(id: string): void;
  onBrowse?(id: ExternalSourceView['id']): void;
}) {
  return (
    <div className="un-srcset-group">
      <h4>{title}</h4>
      {sources.length ? (
        <ul className="un-pref-group un-srcset-list">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              controller={rest.controller}
              favorite={rest.favorites.includes(source.id)}
              toggleFavorite={rest.toggleFavorite}
              onBrowse={rest.onBrowse}
            />
          ))}
        </ul>
      ) : (
        <p className="un-srcset-empty">{empty}</p>
      )}
    </div>
  );
}

/**
 * 콘텐츠 소스: installed packages first, then every source with its connection, then how source episodes open,
 * and one rarely changed progress option.
 */
export function SourcesPage({
  installedPackages,
  sourceReadingSettings,
  externalSources,
  settingsController,
  onBrowse,
}: {
  installedPackages?: ReactNode;
  sourceReadingSettings: ReactNode;
  externalSources: ExternalSourceController;
  settingsController: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  onBrowse(id: ExternalSourceView['id']): void;
}) {
  const model = useExternalSourceSettingsModel(externalSources);
  const shared = {
    controller: externalSources,
    favorites: model.favorites,
    toggleFavorite: model.toggleFavorite,
    onBrowse,
  };
  return (
    <>
      {installedPackages}

      <PrefSection title="소스" hint="작품을 가져오는 곳이에요. 눌러서 연결하고 둘러봐요.">
        {model.filterable && (
          <div className="un-srcset-filters">
            <label className="un-srcset-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                className="un-input"
                aria-label="소스 검색"
                placeholder="이름이나 설명으로 찾기"
                value={model.query}
                onChange={(event) => model.setQuery(event.target.value)}
              />
            </label>
            <PrefChips
              label="소스 거르기"
              value={model.state === 'favorite' ? 'favorite' : model.kind}
              options={[
                { value: 'all', label: '전체' },
                { value: 'favorite', label: '즐겨찾기' },
                { value: 'text', label: '소설' },
                { value: 'image', label: '만화' },
              ]}
              onChange={(value) => {
                if (value === 'favorite') {
                  model.setKind('all');
                  model.setState('favorite');
                } else {
                  model.setState('all');
                  model.setKind(value);
                }
              }}
            />
            {model.languages.length > 1 && (
              <select
                className="un-select"
                aria-label="언어"
                value={model.language}
                onChange={(event) => model.setLanguage(event.target.value)}
              >
                <option value="*">모든 언어</option>
                {model.languages.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang === 'all' ? '다국어' : lang}
                  </option>
                ))}
                <option value="unknown">언어 정보 없음</option>
              </select>
            )}
            <small className="un-srcset-count" role="status">
              {model.filtered.length} / {externalSources.sources.length}개
            </small>
          </div>
        )}
        {model.error && (
          <Notice tone="danger">즐겨찾기를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.</Notice>
        )}
        {model.filtered.length === 0 ? (
          <EmptyState icon={<Search size={22} />} title="맞는 소스가 없어요" body="검색어나 거르기를 바꿔 보세요." />
        ) : (
          <>
            <SourceList title="기본 소스" sources={model.builtIn} empty="쓸 수 있는 기본 소스가 없어요." {...shared} />
            <SourceList
              title="설치한 소스"
              sources={model.plugins}
              empty="설치한 확장이 주는 소스가 없어요."
              {...shared}
            />
          </>
        )}
      </PrefSection>

      {sourceReadingSettings}

      <PrefFold title="고급" summary="진행률 기준">
        <PrefSwitch
          title="받은 회차 기준으로 진행률 보기"
          help="받아 둔 작품은 받은 회차 중 몇 화까지 읽었는지로 보여요. 바로 읽기만 한 작품은 소스 전체 회차 기준이에요."
          checked={settingsController.settings.sourceProgressBasis === 'downloaded'}
          onChange={(on) => settingsController.updateSettings({ sourceProgressBasis: on ? 'downloaded' : 'source' })}
        />
      </PrefFold>
    </>
  );
}
