import { PluginConnections } from './PluginConnections';
import {
  usePluginJsonFieldModel,
  usePluginConfigEditorModel,
  usePluginViewModel,
  usePluginReaderInputModel,
} from './use-platform-plugin-editor-models';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { Dialog } from '../../shared/ui/Dialog';
import { useProductPlugins } from './PlatformPluginProvider';
import type { ProductPluginSession } from './product-session';
import type { ConfigRow, Installation } from './store-model';
import type { SettingsField } from './settings-schema';
import { usePlatformPluginSettingsModel } from './use-platform-plugin-settings-model';
import type { PluginSettingsFailure } from './plugin-settings-failure';
import {
  PLUGIN_ACCOUNT_DESCRIPTION,
  pluginCapabilities,
  pluginCapabilityWarnings,
  pluginConnectionAccess,
  pluginContributionLabel,
  pluginFaultText,
  pluginHomeSectionTitles,
} from './plugin-presentation';
import './product-plugins.css';

const failure = (issue: PluginSettingsFailure) => {
  if (issue.code === 'migration_requires_disabled')
    return '설정을 이전하려면 먼저 플러그인을 끄고 파일을 다시 검토해 주세요.';
  if (issue.code === 'disable_revoke_failed')
    return '플러그인은 중지했습니다. 서버 연결이 없어 보관된 연결 정보의 삭제는 확인하지 못했습니다.';
  if (issue.code === 'remove_revoke_failed')
    return '플러그인은 제거했습니다. 서버 연결이 없어 보관된 연결 정보의 삭제는 확인하지 못했습니다.';
  if (issue.code === 'review_stale') return '플러그인이 변경됐거나 검토가 끝났습니다. 파일을 다시 선택해 주세요.';
  if (issue.code === 'update_revoke_failed')
    return '업데이트는 완료했습니다. 이전 외부 연결 정리는 확인하지 못했습니다.';
  if (issue.code === 'connection_setup_failed')
    return '플러그인은 설치했습니다. 아래 외부 서비스에서 연결을 다시 저장해 주세요.';
  if (issue.code === 'missing_config') return '작성자가 제공한 공통 설정이 없습니다. 플러그인 화면을 확인해 주세요.';
  return issue.cause instanceof Error ? issue.cause.message : '처리하지 못했습니다.';
};
function Field({
  name,
  field,
  value,
  change,
}: {
  name: string;
  field: SettingsField;
  value: UiJson;
  change(value: UiJson): void;
}) {
  const label = field.label ?? name;
  if (field.type === 'group')
    return (
      <fieldset>
        <legend>{label}</legend>
        {Object.entries(field.fields).map(([key, child]) => (
          <Field
            key={key}
            name={key}
            field={child}
            value={(value as Record<string, UiJson>)[key]}
            change={(next) => change({ ...(value as Record<string, UiJson>), [key]: next })}
          />
        ))}
      </fieldset>
    );
  if (field.type === 'boolean')
    return (
      <label className="product-plugin-toggle">
        <input type="checkbox" checked={value === true} onChange={(e) => change(e.target.checked)} />
        {label}
      </label>
    );
  return (
    <label>
      {label}
      {field.description && <small>{field.description}</small>}
      {field.type === 'enum' ? (
        <select value={String(value)} onChange={(e) => change(e.target.value)}>
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : field.type === 'list' ? (
        <JsonField value={value} change={change} />
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={String(value)}
          min={field.type === 'number' ? field.min : undefined}
          max={field.type === 'number' ? field.max : undefined}
          onChange={(e) => change(field.type === 'number' ? Number(e.target.value) : e.target.value)}
        />
      )}
    </label>
  );
}
function JsonField({ value, change }: { value: UiJson; change(value: UiJson): void }) {
  const { text, changeText } = usePluginJsonFieldModel(value, change);
  return (
    <textarea
      value={text}
      onChange={(e) => {
        e.target.setCustomValidity(changeText(e.target.value) ? '' : '올바른 JSON 배열을 입력해 주세요.');
      }}
    />
  );
}
function ConfigEditor({
  session,
  row,
  config,
  saved,
}: {
  session: ProductPluginSession;
  row: Installation;
  config: ConfigRow;
  saved(): void;
}) {
  const { value, setValue, error: issue, busy, save } = usePluginConfigEditorModel(session, row, config, saved);
  const error = issue ? failure(issue) : '';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy}>
        {Object.entries(config.schema.fields).map(([key, field]) => (
          <Field
            key={key}
            name={key}
            field={field}
            value={value[key]}
            change={(next) => setValue((old) => ({ ...old, [key]: next }))}
          />
        ))}
        <button className="primary-btn" type="submit">
          설정 저장
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function PluginViewPanel({
  session,
  id,
  view,
  close,
}: {
  session: ProductPluginSession;
  id: string;
  view: string;
  close(): void;
}) {
  const { container, error: issue } = usePluginViewModel(session, id, view);
  const error = issue ? failure(issue) : '';
  return (
    <Dialog open title={pluginContributionLabel('view', view, [view])} closeLabel="플러그인 화면 닫기" onClose={close}>
      {error && <p role="alert">{error}</p>}
      <div className="product-plugin-view" ref={container} />
    </Dialog>
  );
}
function ReaderInputSetting({ session, row }: { session: ProductPluginSession; row: Installation }) {
  const {
    selected,
    error: issue,
    available,
    selectCommand,
    selectEdge,
    commands,
  } = usePluginReaderInputModel(session, row);
  const error = issue ? failure(issue) : '';
  if (!available) return null;
  return (
    <fieldset>
      <legend>독서 중 길게 누르기</legend>
      <p>
        선택한 명령을 누르는 동안 실행합니다. 놓거나 다른 조작을 하면 중지됩니다. Alt+Shift+Space도 사용할 수 있습니다.
        본문 선택 동작은 유지됩니다.
      </p>
      <label>
        입력 명령
        <select
          aria-label="독서 입력 명령"
          value={selected?.command ?? ''}
          onChange={(e) => selectCommand(e.target.value)}
        >
          <option value="">연결 안 함</option>
          {commands.map((c) => (
            <option key={c} value={c}>
              {pluginContributionLabel('command', c, commands)}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <label>
          입력 영역
          <select
            aria-label="독서 입력 영역"
            value={selected.edge}
            onChange={(e) => selectEdge(e.target.value as 'left' | 'right' | 'keyboard')}
          >
            <option value="right">오른쪽 여백</option>
            <option value="left">왼쪽 여백</option>
            <option value="keyboard">키보드만</option>
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
export function PlatformPluginSettings() {
  const { session, message, retry } = useProductPlugins();
  return (
    <section className="product-plugins" aria-label="플러그인">
      <h3>플러그인</h3>
      <p>{PLUGIN_ACCOUNT_DESCRIPTION}</p>
      <p>홈과 읽기 화면의 기능을 추가합니다. 작품을 검색하고 가져오는 서비스는 소스 설정에서 관리하세요.</p>
      {message && <p role="status">{message}</p>}
      {session ? (
        <Installed key={session.instanceId} session={session} />
      ) : (
        <button type="button" className="ghost-btn" onClick={retry}>
          환경 다시 확인
        </button>
      )}
    </section>
  );
}
function Installed({ session }: { session: ProductPluginSession }) {
  const {
    rows,
    error: issue,
    busy,
    review,
    setReview,
    preserve,
    setPreserve,
    config,
    setConfig,
    view,
    setView,
    faults,
    run,
    approve,
    inspectFile,
    toggle,
    remove,
    openConfig,
    reviewPrevious,
    acknowledge,
    recoveryIds,
    command,
  } = usePlatformPluginSettingsModel(session);
  const error = issue ? failure(issue) : '';
  return (
    <>
      <label>
        플러그인 파일
        <input
          aria-label="플러그인 파일"
          type="file"
          accept=".js,.zip,.boaaext,.moyaext"
          disabled={busy || session.off}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) inspectFile(file);
          }}
        />
      </label>
      <a href="?plugins=off">모든 플러그인을 중지하고 복구하기</a>
      {error && <p role="alert">{error}</p>}
      {review && (
        <section aria-label="플러그인 설치 검토" className="extension-settings-card">
          <strong>
            {review.manifest.extension.name} · {review.manifest.extension.version}
          </strong>
          <details>
            <summary>기술 정보</summary>
            <p>
              {review.pluginId} · {review.publisher ? `서명자: ${review.publisher}` : '서명되지 않은 파일'}
            </p>
            <p>
              SHA-256 <code>{review.digest}</code>
            </p>
            <p>
              실행 시점: {review.manifest.activation.join(', ')} · 저장 공간{' '}
              {review.manifest.requestedAccess.storageKiB} KiB
            </p>
          </details>
          {review.publisherChanged && <p>서명자가 변경됩니다.</p>}
          {review.sourceChanged && <p>파일 출처가 변경됩니다.</p>}
          {review.downgrade && <p>이전 버전으로 되돌립니다.</p>}
          {review.sameVersionReplacement && <p>같은 버전 이름의 코드가 교체됩니다.</p>}
          {pluginHomeSectionTitles(review.manifest).length > 0 && (
            <p>
              홈에 추가되는 목록: {pluginHomeSectionTitles(review.manifest).join(', ')}. 작품을 누르면 제목으로
              검색합니다.
            </p>
          )}
          <p>설치하면 다음 기능에 필요한 권한을 허용합니다.</p>
          {pluginCapabilities(review.manifest).map((group) => (
            <section key={group.title}>
              <h4>{group.title}</h4>
              <ul>
                {group.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </section>
          ))}
          {pluginCapabilityWarnings(review.manifest).map((warning) => (
            <p key={warning} role="note">
              {warning}
            </p>
          ))}
          {review.manifest.connections?.map((connection) => (
            <p key={connection.id}>
              {connection.title} · {connection.endpoint} · {pluginConnectionAccess(connection.methods)} (
              {connection.methods.join(', ')})
            </p>
          ))}
          {review.expectedRevision > 0 && (
            <label className="product-plugin-toggle">
              <input
                type="checkbox"
                checked={preserve}
                disabled={review.publisherChanged || review.sourceChanged}
                onChange={(e) => setPreserve(e.target.checked)}
              />
              기존 설정·저장 자료 유지
            </label>
          )}
          {!preserve && review.expectedRevision > 0 && <p>승인하면 기존 플러그인의 설정·저장 자료를 초기화합니다.</p>}
          <button type="button" className="primary-btn" disabled={busy || session.off} onClick={() => run(approve)}>
            {review.expectedRevision > 0 ? '확인하고 적용' : '확인하고 설치'}
          </button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => setReview(undefined)}>
            검토 취소
          </button>
        </section>
      )}
      {rows.map((row) => (
        <article className="extension-settings-card" key={row.pluginId}>
          <strong>{row.manifest?.extension.name ?? row.pluginId}</strong>
          <p>
            {row.manifest?.extension.version} · {row.enabled ? '사용 중' : '꺼짐'}
          </p>
          {faults
            .filter((f) => f.id === row.pluginId)
            .map((f) => (
              <p role="status" key={f.code}>
                {pluginFaultText(f.code)} 끈 뒤 다시 켜면 새로 시작해요. ({f.code})
              </p>
            ))}
          {row.manifest && (
            <p>
              {pluginCapabilities(row.manifest)
                .map((group) => group.title)
                .join(' · ')}
            </p>
          )}
          <ReaderInputSetting session={session} row={row} />
          <PluginConnections session={session} row={row} />
          <div className="product-plugin-actions">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || (!row.enabled && session.off)}
              onClick={() => toggle(row)}
            >
              {row.enabled ? '끄기' : '권한 검토 후 켜기'}
            </button>
            {Object.values(row.manifest?.entries ?? {}).some((entry) => entry.permissions.includes('settings.own')) && (
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => openConfig(row)}>
                설정
              </button>
            )}
            {row.previous && (
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || session.off}
                onClick={() => reviewPrevious(row)}
              >
                이전 파일 검토
              </button>
            )}
            {!row.enabled && recoveryIds.has(row.pluginId) && (
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => acknowledge(row)}>
                중단 기록 정리
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                if (window.confirm('이 플러그인과 저장 자료를 삭제할까요?')) remove(row);
              }}
            >
              제거
            </button>
            {row.enabled &&
              !session.off &&
              row.manifest?.contributes.views.map((v) => (
                <button
                  type="button"
                  className="ghost-btn"
                  key={v}
                  onClick={() => setView({ id: row.pluginId, view: v })}
                >
                  {pluginContributionLabel('view', v, row.manifest!.contributes.views)}
                </button>
              ))}
            {row.enabled &&
              !session.off &&
              row.manifest?.contributes.commands.map((c) => (
                <button type="button" className="ghost-btn" key={c} disabled={busy} onClick={() => command(row, c)}>
                  {pluginContributionLabel('command', c, row.manifest!.contributes.commands)}
                </button>
              ))}
          </div>
        </article>
      ))}
      {config && (
        <Dialog open title="플러그인 설정" closeLabel="플러그인 설정 닫기" onClose={() => setConfig(undefined)}>
          <ConfigEditor
            key={`${config.row.pluginId}:${config.value.revision}`}
            session={session}
            row={config.row}
            config={config.value}
            saved={() => setConfig(undefined)}
          />
        </Dialog>
      )}
      {view && <PluginViewPanel session={session} {...view} close={() => setView(undefined)} />}
    </>
  );
}
