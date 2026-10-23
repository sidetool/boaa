import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { AppWindow, Code2, FileUp, House, LifeBuoy, Play, Settings2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useProductPlugins } from '../../../extensions/platform/PlatformPluginProvider';
import type { PluginSettingsFailure } from '../../../extensions/platform/plugin-settings-failure';
import type { ProductPluginSession } from '../../../extensions/platform/product-session';
import type { SettingsField } from '../../../extensions/platform/settings-schema';
import type { ConfigRow, Installation } from '../../../extensions/platform/store-model';
import {
  usePluginConfigEditorModel,
  usePluginJsonFieldModel,
  usePluginReaderInputModel,
  usePluginViewModel,
} from '../../../extensions/platform/use-platform-plugin-editor-models';
import {
  pluginContributionLabel,
  pluginFaultText,
  pluginHomeSectionTitles,
} from '../../../extensions/platform/plugin-presentation';
import {
  usePlatformPluginSettingsModel,
  type PlatformPluginSettingsModel,
} from '../../../extensions/platform/use-platform-plugin-settings-model';
import { ConfirmSheet } from '../../components/dialogs';
import { PluginConnectionFolds } from './PluginConnectionFold';
import { PluginCapabilityChips, PluginReviewSheet } from './PluginReviewSheet';
import { cx, Sheet, Switch } from '../../components/primitives';
import {
  EmptyState,
  Notice,
  Pref,
  PrefField,
  PrefFold,
  PrefGroup,
  PrefSection,
  PrefSkeleton,
  PrefSwitch,
} from '../../components/prefs';

const SECTION_HINT =
  '홈에 추천 목록을 더하거나 읽기를 돕는 기능이에요. 내 계정에 저장되어 다른 기기에서도 그대로 쓸 수 있어요.';

function failureText(issue: PluginSettingsFailure) {
  switch (issue.code) {
    case 'migration_requires_disabled':
      return '설정을 옮기려면 먼저 플러그인을 끄고 파일을 다시 검토해 주세요.';
    case 'disable_revoke_failed':
      return '플러그인은 멈췄어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
    case 'remove_revoke_failed':
      return '플러그인은 지웠어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
    case 'review_stale':
      return '다른 기기에서 플러그인이 변경됐거나 검토가 끝났어요. 파일을 다시 선택해 주세요.';
    case 'update_revoke_failed':
      return '업데이트는 완료했어요. 이전 연결 정리는 확인하지 못했어요. 외부 서비스 연결을 확인해 주세요.';
    case 'connection_setup_failed':
      return '플러그인은 설치했어요. 아래 외부 서비스에서 연결을 다시 저장해 주세요.';
    case 'missing_config':
      return '작성자가 공통 설정을 주지 않았어요. 플러그인 화면을 확인해 주세요.';
    default:
      return issue.cause instanceof Error ? issue.cause.message : '처리하지 못했어요.';
  }
}

function JsonField({ label, value, change }: { label: string; value: UiJson; change(value: UiJson): void }) {
  const { text, valid, changeText } = usePluginJsonFieldModel(value, change);
  return (
    <PrefField label={label} error={valid ? undefined : 'JSON 배열 모양으로 적어 주세요.'}>
      <textarea value={text} spellCheck={false} onChange={(event) => changeText(event.target.value)} />
    </PrefField>
  );
}

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
      <PrefFold title={label} defaultOpen>
        {Object.entries(field.fields).map(([key, child]) => (
          <Field
            key={key}
            name={key}
            field={child}
            value={(value as Record<string, UiJson>)[key]}
            change={(next) => change({ ...(value as Record<string, UiJson>), [key]: next })}
          />
        ))}
      </PrefFold>
    );
  if (field.type === 'boolean') return <PrefSwitch title={label} checked={value === true} onChange={change} />;
  if (field.type === 'list') return <JsonField label={label} value={value} change={change} />;
  return (
    <PrefField label={label} help={field.description}>
      {field.type === 'enum' ? (
        <select value={String(value)} onChange={(event) => change(event.target.value)}>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={String(value)}
          min={field.type === 'number' ? field.min : undefined}
          max={field.type === 'number' ? field.max : undefined}
          onChange={(event) => change(field.type === 'number' ? Number(event.target.value) : event.target.value)}
        />
      )}
    </PrefField>
  );
}

function ConfigSheet({
  session,
  row,
  config,
  close,
}: {
  session: ProductPluginSession;
  row: Installation;
  config: ConfigRow;
  close(): void;
}) {
  const model = usePluginConfigEditorModel(session, row, config, close);
  return (
    <Sheet
      open
      onClose={close}
      title={`${row.manifest?.extension.name ?? row.pluginId} 설정`}
      footer={
        <button type="submit" form="un-plugin-config" className="un-btn is-primary" disabled={model.busy}>
          저장
        </button>
      }
    >
      <form
        id="un-plugin-config"
        className="un-plugin-config"
        onSubmit={(event) => {
          event.preventDefault();
          void model.save();
        }}
      >
        <PrefGroup>
          {Object.entries(config.schema.fields).map(([key, field]) => (
            <Field
              key={key}
              name={key}
              field={field}
              value={model.value[key]}
              change={(next) => model.setValue((old) => ({ ...old, [key]: next }))}
            />
          ))}
        </PrefGroup>
        {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}
      </form>
    </Sheet>
  );
}

function ViewSheet({
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
  const model = usePluginViewModel(session, id, view);
  return (
    <Sheet open onClose={close} title={pluginContributionLabel('view', view, [view])}>
      {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}
      <div className="product-plugin-view un-plugin-view" ref={model.container} />
    </Sheet>
  );
}

function ReaderInput({ session, row }: { session: ProductPluginSession; row: Installation }) {
  const model = usePluginReaderInputModel(session, row);
  if (!model.available) return null;
  return (
    <PrefFold
      title="읽는 중 길게 누르기"
      summary={
        model.selected ? pluginContributionLabel('command', model.selected.command, model.commands) : '연결 안 함'
      }
    >
      <Pref
        title="명령"
        help="누르고 있는 동안 실행하고, 떼면 멈춰요. Alt+Shift+Space로도 돼요."
        control={
          <select
            className="un-select"
            aria-label="리더 입력 명령"
            value={model.selected?.command ?? ''}
            onChange={(event) => model.selectCommand(event.target.value)}
          >
            <option value="">연결 안 함</option>
            {model.commands.map((command) => (
              <option key={command} value={command}>
                {pluginContributionLabel('command', command, model.commands)}
              </option>
            ))}
          </select>
        }
      />
      {model.selected && (
        <Pref
          title="누르는 곳"
          control={
            <select
              className="un-select"
              aria-label="리더 입력 영역"
              value={model.selected.edge}
              onChange={(event) => model.selectEdge(event.target.value as 'left' | 'right' | 'keyboard')}
            >
              <option value="right">오른쪽 여백</option>
              <option value="left">왼쪽 여백</option>
              <option value="keyboard">키보드만</option>
            </select>
          }
        />
      )}
      {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}
    </PrefFold>
  );
}

function PluginCard({
  row,
  session,
  model,
  remove,
}: {
  row: Installation;
  session: ProductPluginSession;
  model: PlatformPluginSettingsModel;
  remove(row: Installation): void;
}) {
  const name = row.manifest?.extension.name ?? row.pluginId;
  const live = row.enabled && !session.off;
  const homeTitles = pluginHomeSectionTitles(row.manifest);
  const status = !row.enabled ? '꺼짐' : session.off ? '복구 모드로 멈춤' : '사용 중';
  const configurable = Object.values(row.manifest?.entries ?? {}).some((entry) =>
    entry.permissions.includes('settings.own'),
  );
  return (
    <article className={cx('un-ext-card un-plugin-card', !live && 'is-off')}>
      <header className="un-ext-card-head">
        <span className="un-ext-icon" aria-hidden="true">
          <Code2 size={18} />
        </span>
        <div className="un-ext-title">
          <strong>{name}</strong>
          <small>
            {row.manifest?.extension.version && `v${row.manifest.extension.version} · `}
            {status}
          </small>
        </div>
        <Switch
          label={`${name} ${row.enabled ? '끄기' : '켜기'}`}
          checked={row.enabled}
          disabled={model.busy || (!row.enabled && session.off)}
          onChange={() => model.toggle(row)}
        />
      </header>
      {row.manifest && <PluginCapabilityChips manifest={row.manifest} />}
      {homeTitles.length > 0 && (
        <p className="un-plugin-home-line">
          <House size={14} aria-hidden="true" />
          <span>
            홈 목록 <b>{homeTitles.join(', ')}</b>
          </span>
        </p>
      )}
      {!row.enabled && <p className="un-plugin-muted">켜면 허용할 기능을 다시 확인해요.</p>}
      {model.faults
        .filter((fault) => fault.id === row.pluginId)
        .map((fault) => (
          <Notice key={fault.code} tone="warning">
            {pluginFaultText(fault.code)} 끈 뒤 다시 켜면 새로 시작해요.
            <small className="un-plugin-code">{fault.code}</small>
          </Notice>
        ))}
      <ReaderInput session={session} row={row} />
      <PluginConnectionFolds session={session} row={row} />
      <div className="un-plugin-actions">
        {configurable && (
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            disabled={model.busy}
            onClick={() => model.openConfig(row)}
          >
            <Settings2 size={15} />
            설정
          </button>
        )}
        {live &&
          row.manifest?.contributes.views.map((view) => (
            <button
              key={view}
              type="button"
              className="un-btn is-ghost is-sm"
              onClick={() => model.setView({ id: row.pluginId, view })}
            >
              <AppWindow size={15} />
              {pluginContributionLabel('view', view, row.manifest!.contributes.views)}
            </button>
          ))}
        {live &&
          row.manifest?.contributes.commands.map((command) => (
            <button
              key={command}
              type="button"
              className="un-btn is-ghost is-sm"
              disabled={model.busy}
              onClick={() => model.command(row, command)}
            >
              <Play size={14} />
              {pluginContributionLabel('command', command, row.manifest!.contributes.commands)}
            </button>
          ))}
        <span className="un-plugin-actions-end">
          {row.previous && (
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={model.busy || session.off}
              onClick={() => model.reviewPrevious(row)}
            >
              이전 파일로
            </button>
          )}
          {!row.enabled && model.recoveryIds.has(row.pluginId) && (
            <button
              type="button"
              className="un-btn is-text is-sm"
              disabled={model.busy}
              onClick={() => model.acknowledge(row)}
            >
              멈춤 기록 지우기
            </button>
          )}
          <button
            type="button"
            className="un-icon-btn is-sm"
            aria-label={`${name} 지우기`}
            disabled={model.busy}
            onClick={() => remove(row)}
          >
            <Trash2 size={15} />
          </button>
        </span>
      </div>
    </article>
  );
}

function Installed({ session, message }: { session: ProductPluginSession; message?: string }) {
  const model = usePlatformPluginSettingsModel(session);
  const file = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<Installation>();
  const empty = !model.loading && !model.rows.length;
  const install = (primary: boolean) => (
    <button
      type="button"
      className={cx('un-btn', primary ? 'is-primary' : 'is-ghost is-sm')}
      disabled={model.busy || session.off}
      onClick={() => file.current?.click()}
    >
      <FileUp size={primary ? 17 : 15} />
      파일로 설치
    </button>
  );
  return (
    <PrefSection title="플러그인" hint={SECTION_HINT} action={!empty && install(false)}>
      <input
        ref={file}
        type="file"
        hidden
        aria-label="플러그인 파일"
        accept=".js,.zip,.boaaext,.moyaext"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = '';
          if (picked) model.inspectFile(picked);
        }}
      />
      {message && <Notice tone="warning">{message}</Notice>}
      {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}

      {model.loading ? (
        <PrefSkeleton rows={2} />
      ) : model.rows.length ? (
        <div className="un-ext-cards">
          {model.rows.map((row) => (
            <PluginCard key={row.pluginId} row={row} session={session} model={model} remove={setRemoving} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Code2 size={22} />}
          title="설치한 플러그인이 없어요"
          body="받은 플러그인 파일을 고르면 하는 일을 먼저 보여 드리고, 확인한 뒤에 설치해요."
          action={install(true)}
        />
      )}

      <footer className="un-plugin-foot">
        <p>작품을 검색하고 가져오는 서비스는 소스 설정에서 관리해요.</p>
        <p>
          플러그인 때문에 화면이 멈추거나 이상하다면
          <a className="un-btn is-text is-sm" href="?plugins=off">
            <LifeBuoy size={15} />
            모두 멈추고 복구
          </a>
        </p>
      </footer>

      <PluginReviewSheet model={model} session={session} />
      {model.config && (
        <ConfigSheet
          key={`${model.config.row.pluginId}:${model.config.value.revision}`}
          session={session}
          row={model.config.row}
          config={model.config.value}
          close={() => model.setConfig(undefined)}
        />
      )}
      {model.view && <ViewSheet session={session} {...model.view} close={() => model.setView(undefined)} />}
      <ConfirmSheet
        open={Boolean(removing)}
        title="플러그인을 지울까요?"
        confirmLabel="지우기"
        danger
        onConfirm={() => removing && model.remove(removing)}
        onClose={() => setRemoving(undefined)}
      >
        <p>
          ‘{removing?.manifest?.extension.name ?? removing?.pluginId}’ 플러그인과 설정·저장 자료를 지워요. 같은 계정의
          다른 기기에서도 사라져요.
        </p>
      </ConfirmSheet>
    </PrefSection>
  );
}

/** Account plugins expose capabilities without requiring users to choose a runtime format. */
export function PluginsSection() {
  const { session, message, code, retry } = useProductPlugins();
  if (session) return <Installed key={session.instanceId} session={session} message={message} />;
  return (
    <PrefSection title="플러그인" hint={SECTION_HINT}>
      <Notice
        tone={message === '플러그인 환경 확인 중' ? 'info' : 'warning'}
        action={
          <button type="button" className="un-btn is-text is-sm" onClick={retry}>
            다시 확인
          </button>
        }
      >
        {code ? '이 서버에서는 플러그인을 쓸 수 없어요.' : message}
      </Notice>
    </PrefSection>
  );
}
