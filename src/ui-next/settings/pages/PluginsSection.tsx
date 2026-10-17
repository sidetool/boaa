import type { EntryRole, PlatformPermission } from '@boaa/extension-contracts/platform-package';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
import { Code2, LifeBuoy, Play, Settings2, Trash2 } from 'lucide-react';
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
import { usePlatformPluginSettingsModel } from '../../../extensions/platform/use-platform-plugin-settings-model';
import { ConfirmSheet } from '../../components/dialogs';
import { PluginConnectionFolds } from './PluginConnectionFold';
import { Sheet, Switch } from '../../components/primitives';
import {
  EmptyState,
  Notice,
  Pref,
  PrefField,
  PrefFold,
  PrefGroup,
  PrefSection,
  PrefSwitch,
} from '../../components/prefs';

const PERMISSION: Record<PlatformPermission, string> = {
  'http.request': '허락한 외부 서버로 요청·자료 보내기 (본문 권한이 있으면 본문도)',
  'settings.own': '자기 설정 읽고 바꾸기',
  'storage.own': '자기 저장 공간 쓰기',
  'commands.register': '플러그인 명령 등록',
  'ui.render': '자기 화면 보여 주기',
  'reader.content.visible': '지금 보이는 본문 읽기',
  'reader.annotations.read': '이 책의 북마크·하이라이트·메모 읽기',
  'reader.annotations.write': '이 책의 주석 만들고 고치고 지우기 (플러그인을 꺼도 남아요)',
  'reader.state': '열린 리더 상태 읽기',
  'reader.control': '허락한 입력 중에 자동 스크롤 조작',
  'reader.input': '연결한 리더 입력 받기',
  'reader.content.book': '열린 책 전체 본문 읽기',
  'reader.decorations': '본문에 색·서식 입히기',
};

function failureText(issue: PluginSettingsFailure) {
  switch (issue.code) {
    case 'migration_requires_disabled':
      return '설정을 옮기려면 먼저 플러그인을 끄고 파일을 다시 검토해 주세요.';
    case 'disable_revoke_failed':
      return '플러그인은 멈췄어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
    case 'remove_revoke_failed':
      return '플러그인은 지웠어요. 서버에 닿지 않아 보관된 연결 정보가 지워졌는지는 확인하지 못했어요.';
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
    <Sheet open onClose={close} title={view}>
      {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}
      <div className="product-plugin-view un-plugin-view" ref={model.container} />
    </Sheet>
  );
}

function ReaderInput({ session, row }: { session: ProductPluginSession; row: Installation }) {
  const model = usePluginReaderInputModel(session, row);
  if (!model.available) return null;
  return (
    <PrefFold title="읽는 중 길게 누르기" summary={model.selected ? model.selected.command : '연결 안 함'}>
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
              <option key={command}>{command}</option>
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

function ReviewSheet({
  model,
  session,
}: {
  model: ReturnType<typeof usePlatformPluginSettingsModel>;
  session: ProductPluginSession;
}) {
  const review = model.review;
  if (!review) return null;
  const replacing = review.expectedRevision > 0;
  return (
    <Sheet
      open
      onClose={() => model.setReview(undefined)}
      title="설치 전 확인"
      footer={
        <>
          <button
            type="button"
            className="un-btn is-ghost"
            disabled={model.busy}
            onClick={() => model.setReview(undefined)}
          >
            취소
          </button>
          <button
            type="button"
            className="un-btn is-primary"
            disabled={model.busy || session.off}
            onClick={() => model.run(model.approve)}
          >
            허락하고 쓰기
          </button>
        </>
      }
    >
      <div className="un-plugin-review">
        <header>
          <strong>{review.manifest.extension.name}</strong>
          <small>
            v{review.manifest.extension.version} · {review.publisher ? `서명: ${review.publisher}` : '서명 없음'}
          </small>
        </header>
        {!review.publisher && (
          <Notice tone="warning">서명되지 않은 파일이에요. 믿을 수 있는 곳에서 받은 파일만 설치하세요.</Notice>
        )}
        {review.publisherChanged && <Notice tone="warning">서명한 사람이 바뀌어요.</Notice>}
        {review.sourceChanged && <Notice tone="warning">파일을 받은 곳이 바뀌어요.</Notice>}
        {review.downgrade && <Notice tone="warning">이전 버전으로 되돌려요.</Notice>}
        {review.sameVersionReplacement && <Notice tone="warning">같은 버전 이름으로 코드가 바뀌어요.</Notice>}

        {Object.entries(review.manifest.entries).map(([role, entry]) => (
          <section key={role} className="un-plugin-role">
            <h4>{role} 권한</h4>
            {entry.permissions.length ? (
              <PrefGroup>
                {entry.permissions.map((permission) => (
                  <PrefSwitch
                    key={permission}
                    title={PERMISSION[permission]}
                    checked={model.grants[role as EntryRole]?.includes(permission) ?? false}
                    onChange={(on) => model.setPermission(role as EntryRole, permission, on)}
                  />
                ))}
              </PrefGroup>
            ) : (
              <p className="un-plugin-muted">요청한 권한이 없어요.</p>
            )}
          </section>
        ))}

        {replacing && (
          <PrefGroup>
            <PrefSwitch
              title="지금 설정과 저장 자료 그대로 두기"
              help={
                model.preserve
                  ? '바꿀 때 작성자의 이전 코드가 한 번 실행돼요.'
                  : '허락하면 이 플러그인의 설정과 저장 자료를 지워요.'
              }
              checked={model.preserve}
              disabled={review.publisherChanged || review.sourceChanged}
              onChange={model.setPreserve}
            />
          </PrefGroup>
        )}

        <dl className="un-plugin-facts">
          <div>
            <dt>ID</dt>
            <dd>{review.pluginId}</dd>
          </div>
          <div>
            <dt>실행 시점</dt>
            <dd>{review.manifest.activation.join(', ')}</dd>
          </div>
          <div>
            <dt>저장 공간</dt>
            <dd>{review.manifest.requestedAccess.storageKiB} KiB</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>
              <code>{review.digest}</code>
            </dd>
          </div>
        </dl>
      </div>
    </Sheet>
  );
}

function Installed({ session }: { session: ProductPluginSession }) {
  const model = usePlatformPluginSettingsModel(session);
  const file = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<Installation>();
  return (
    <>
      <div className="un-plugin-toolbar">
        <input
          ref={file}
          type="file"
          hidden
          aria-label="JS 플러그인 파일"
          accept=".js,.zip,.boaaext,.moyaext"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = '';
            if (picked) model.inspectFile(picked);
          }}
        />
        <button
          type="button"
          className="un-btn is-ghost"
          disabled={model.busy || session.off}
          onClick={() => file.current?.click()}
        >
          <Code2 size={16} />
          파일로 설치
        </button>
        <a className="un-btn is-text is-sm" href="?plugins=off">
          <LifeBuoy size={15} />
          모두 멈추고 복구
        </a>
      </div>
      {model.error && <Notice tone="danger">{failureText(model.error)}</Notice>}

      {model.rows.length ? (
        <div className="un-ext-list">
          {model.rows.map((row) => {
            const name = row.manifest?.extension.name ?? row.pluginId;
            const live = row.enabled && !session.off;
            return (
              <article key={row.pluginId} className="un-ext-card">
                <header className="un-ext-head">
                  <span className="un-ext-icon" aria-hidden="true">
                    <Code2 size={18} />
                  </span>
                  <div className="un-ext-title">
                    <strong>{name}</strong>
                    <small>
                      {row.manifest?.extension.version && `v${row.manifest.extension.version} · `}
                      {row.enabled ? '켜짐' : '꺼짐'}
                    </small>
                  </div>
                  <Switch
                    label={`${name} ${row.enabled ? '끄기' : '켜기'}`}
                    checked={row.enabled}
                    disabled={model.busy || (!row.enabled && session.off)}
                    onChange={() => model.toggle(row)}
                  />
                </header>
                {!row.enabled && <p className="un-plugin-muted">켜면 권한을 다시 확인해요.</p>}
                {model.faults
                  .filter((fault) => fault.id === row.pluginId)
                  .map((fault) => (
                    <Notice key={fault.code} tone="warning">
                      {fault.code} · 플러그인을 끈 뒤 복구할 수 있어요.
                    </Notice>
                  ))}
                <ReaderInput session={session} row={row} />
                <PluginConnectionFolds session={session} row={row} />
                <div className="un-plugin-actions">
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    disabled={model.busy}
                    onClick={() => model.openConfig(row)}
                  >
                    <Settings2 size={15} />
                    설정
                  </button>
                  {live &&
                    row.manifest?.contributes.views.map((view) => (
                      <button
                        key={view}
                        type="button"
                        className="un-btn is-ghost is-sm"
                        onClick={() => model.setView({ id: row.pluginId, view })}
                      >
                        {view}
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
                        {command}
                      </button>
                    ))}
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
                  {!row.enabled && (
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
                    className="un-icon-btn is-sm un-plugin-remove"
                    aria-label={`${name} 지우기`}
                    disabled={model.busy}
                    onClick={() => setRemoving(row)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Code2 size={22} />}
          title="설치한 JS 플러그인이 없어요"
          body=".js나 패키지 파일로 설치할 수 있어요."
        />
      )}

      <ReviewSheet model={model} session={session} />
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
        <p>‘{removing?.manifest?.extension.name ?? removing?.pluginId}’와 저장 자료를 지워요.</p>
      </ConfirmSheet>
    </>
  );
}

/** JS 플러그인: installed per account in this browser. Auto-run plugins keep working after settings close. */
export function PluginsSection() {
  const { session, message, code, retry } = useProductPlugins();
  return (
    <PrefSection title="JS 플러그인" hint="이 브라우저의 지금 계정에 설치해요. 본문 서식은 TXT·EPUB에서만 돼요.">
      {session ? (
        <>
          {message && <Notice tone="warning">{message}</Notice>}
          <Installed key={session.instanceId} session={session} />
        </>
      ) : (
        <Notice
          tone={message === '플러그인 환경 확인 중' ? 'info' : 'warning'}
          action={
            <button type="button" className="un-btn is-text is-sm" onClick={retry}>
              다시 확인
            </button>
          }
        >
          {code ? '이 서버에서는 JS 플러그인을 쓸 수 없어요.' : message}
        </Notice>
      )}
    </PrefSection>
  );
}
