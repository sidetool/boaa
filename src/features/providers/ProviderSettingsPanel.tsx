import { Check, FileKey, Headphones, KeyRound, RefreshCw, Trash2, Wand2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderCatalogItem, ProviderOptionConfig, ProviderSecretStatus } from '../../providers/provider-jobs';
import { providerCapabilityFreshnessAt } from '../../providers/provider-capability';
import {
  autoRepairForDraftProvider,
  catalogProviderReady,
  providerOptionValueForDraftProvider,
  providerReadinessLabel,
  providerSettingOptionConfigs,
  requestProfileIdForDraftProvider,
  setDraftDefaultProvider,
  setDraftProviderAutoRepair,
  setDraftProviderEnabled,
  setDraftProviderOption,
  setDraftProviderRequestProfile,
  type ProviderSettingsDraft,
} from '../../providers/provider-settings-ui';
import {
  defaultProviderSecretName,
  providerSecretCanDelete,
  providerSecretDisplayLabel,
  providerSecretDraftKey,
  providerSecretStatusLabel,
} from '../../providers/desktop-provider-catalog';
import type { RemoteProviderSettings } from '../../services/remote/remote-api-client';

type ProviderScope = RemoteProviderSettings['scope'];
type DraftUpdater = (draft: ProviderSettingsDraft) => ProviderSettingsDraft;

export interface ProviderSettingsPanelController {
  readonly available: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly savingScope?: ProviderScope;
  readonly secretStatuses: readonly ProviderSecretStatus[];
  readonly secretDrafts: Readonly<Record<string, string>>;
  readonly secretBusyKey?: string;
  readonly desktopMode: boolean;
  readonly analysisRunning: boolean;
  readonly hostedTTSBusy: boolean;
  readonly desktopLLMSampleBusyProvider?: string;
  readonly desktopTTSSampleBusyProvider?: string;
  updateDraft(scope: ProviderScope, updater: DraftUpdater): void;
  updateSecretDraft(key: string, value: string): void;
  refresh(): void | Promise<unknown>;
  saveSettings(scope: ProviderScope): void | Promise<unknown>;
  saveSecret(scope: ProviderScope, providerId: string, secretName: string): void | Promise<unknown>;
  deleteSecret(scope: ProviderScope, providerId: string, secretName: string): void | Promise<unknown>;
  testSecret(scope: ProviderScope, providerId: string, secretName: string): void | Promise<unknown>;
  runDesktopLLMSample(provider: ProviderCatalogItem, draft: ProviderSettingsDraft): void | Promise<unknown>;
  playDesktopTTSSample(provider: ProviderCatalogItem, draft: ProviderSettingsDraft): void | Promise<unknown>;
}

export interface ProviderSettingsPanelProps {
  readonly scope: ProviderScope;
  readonly title: string;
  readonly providers: readonly ProviderCatalogItem[];
  readonly draft?: ProviderSettingsDraft;
  readonly controller: ProviderSettingsPanelController;
}

// Google service-account files the server accepts; only these TTS providers take one (LLM providers do not).
export const SERVICE_ACCOUNT_SECRET = 'service_account_json';
const SERVICE_ACCOUNT_PROVIDERS = new Set(['gemini-vertex-tts', 'google-cloud-tts']);
const SERVICE_ACCOUNT_MAX_BYTES = 64 * 1024;

/** Checks the minimum shape without keeping or returning any secret field. */
export function inspectServiceAccountJson(text: string): { projectId: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'JSON 형식이 아닙니다.' };
  }
  const value = parsed as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || value.type !== 'service_account')
    return { error: '서비스 계정 키 파일이 아닙니다. (type: service_account)' };
  for (const field of ['client_email', 'project_id', 'private_key'] as const)
    if (typeof value[field] !== 'string' || !value[field]) return { error: `${field} 항목이 없습니다.` };
  return { projectId: value.project_id as string };
}

function ServiceAccountJsonControl({
  scope,
  providerId,
  status,
  controller,
}: {
  readonly scope: ProviderScope;
  readonly providerId: string;
  readonly status: ProviderSecretStatus;
  readonly controller: ProviderSettingsPanelController;
}) {
  const key = providerSecretDraftKey(scope, providerId, SERVICE_ACCOUNT_SECRET);
  const fileInput = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ name: string; projectId: string }>();
  const [error, setError] = useState<string>();
  const drafted = Boolean(controller.secretDrafts[key]);
  const busy = controller.secretBusyKey === key;
  const updateDraft = useRef(controller.updateSecretDraft);
  updateDraft.current = controller.updateSecretDraft;
  // Each pick, cancel or close starts a new generation; a slower file read from an older one is dropped.
  const generation = useRef(0);
  const mounted = useRef(false);
  // The file text lives only in the controller's in-memory draft; drop it when this provider closes.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      updateDraft.current(key, '');
    };
  }, [key]);

  const cancel = () => {
    generation.current += 1;
    updateDraft.current(key, '');
    setPicked(undefined);
    setError(undefined);
  };
  const pick = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    cancel();
    const current = generation.current;
    const stale = () => !mounted.current || generation.current !== current;
    if (file.size > SERVICE_ACCOUNT_MAX_BYTES) return setError('64KiB보다 큰 파일은 쓸 수 없습니다.');
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (!stale()) setError('파일을 읽지 못했습니다. 다시 선택하세요.');
      return;
    }
    if (stale()) return;
    const result = inspectServiceAccountJson(text);
    if ('error' in result) return setError(result.error);
    updateDraft.current(key, text);
    setPicked({ name: file.name, projectId: result.projectId });
  };

  return (
    <div className="provider-secret-control">
      <div className="setting-line">
        <h4>서비스 계정 JSON</h4>
        <span>{status.configured ? `${providerSecretStatusLabel(status)} · 우선 사용` : '미설정'}</span>
      </div>
      <div className="provider-json-actions">
        <button className="ghost-btn is-file" onClick={() => fileInput.current?.click()} disabled={busy}>
          <FileKey size={16} /> {status.configured ? 'JSON 파일 교체' : 'JSON 파일 선택'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="서비스 계정 JSON 파일"
          disabled={busy}
          onChange={(event) => void pick(event.currentTarget)}
        />
        <button
          className="primary-btn"
          onClick={() => void controller.saveSecret(scope, providerId, SERVICE_ACCOUNT_SECRET)}
          disabled={busy || !drafted}
        >
          <KeyRound size={16} /> 저장
        </button>
        {drafted && (
          <button className="ghost-btn" onClick={cancel} disabled={busy}>
            <X size={16} /> 취소
          </button>
        )}
        <button
          className="ghost-btn"
          onClick={() => void controller.testSecret(scope, providerId, SERVICE_ACCOUNT_SECRET)}
          disabled={busy || !status.configured}
        >
          <Check size={16} /> 확인
        </button>
        <button
          className="ghost-btn"
          onClick={() => void controller.deleteSecret(scope, providerId, SERVICE_ACCOUNT_SECRET)}
          disabled={busy || !providerSecretCanDelete(status)}
        >
          <Trash2 size={16} /> 삭제
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      {drafted && picked && (
        <p className="provider-json-picked">
          <b>{picked.name}</b> · project {picked.projectId}
          <small>저장을 눌러야 서버에 보관됩니다.</small>
        </p>
      )}
      <ul className="provider-json-notes">
        <li>
          <b>우선 사용</b> credential path·access token보다 먼저 씁니다. 삭제하면 기존 경로·토큰·서버 env 인증으로
          돌아갑니다.
        </li>
        <li>
          <b>project · location</b> project를 비우면 JSON의 project_id, location은 기본 global입니다.
        </li>
        <li>
          <b>확인</b> 키 보관 여부만 봅니다. IAM 권한이나 실제 합성 성공을 뜻하지 않습니다.
        </li>
        <li>
          <b>요금</b> 듣기 탭에서 이 엔진 목소리를 미리듣거나 재생하면 유료 API가 호출됩니다.
        </li>
        <li>
          <b>범위</b> TTS 엔진 전용이며 LLM 라벨링에는 쓰이지 않습니다. 파일 내용은 화면에 표시하거나 이 기기에 저장하지
          않습니다.
        </li>
      </ul>
    </div>
  );
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function ProviderOptionControl({
  option,
  value,
  onChange,
}: {
  readonly option: ProviderOptionConfig;
  readonly value: string | number | boolean | undefined;
  readonly onChange: (value: string | number | boolean | undefined) => void;
}) {
  const label = (
    <span>
      <strong>{option.displayName}</strong>
      <small>{option.optionKey}</small>
    </span>
  );

  if (option.valueType === 'boolean') {
    return (
      <label className="provider-option-control">
        {label}
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        >
          <option value="">기본값</option>
          <option value="true">켜기</option>
          <option value="false">끄기</option>
        </select>
      </label>
    );
  }

  if (option.valueType === 'select') {
    return (
      <label className="provider-option-control">
        {label}
        <select
          value={value === undefined ? '' : String(value)}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">기본값</option>
          {(option.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (option.valueType === 'number') {
    return (
      <label className="provider-option-control">
        {label}
        <input
          className="text-input"
          type="number"
          min={option.min}
          max={option.max}
          step={option.step ?? 'any'}
          value={value === undefined ? '' : String(value)}
          placeholder={option.defaultValue === undefined ? '' : String(option.defaultValue)}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
      </label>
    );
  }

  return (
    <label className="provider-option-control">
      {label}
      <input
        className="text-input"
        value={value === undefined ? '' : String(value)}
        placeholder={option.defaultValue === undefined ? '' : String(option.defaultValue)}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    </label>
  );
}

export default function ProviderSettingsPanel({
  scope,
  title,
  providers,
  draft,
  controller,
}: ProviderSettingsPanelProps) {
  const defaultProviderId = useId();
  const selectedProviderId = useId();
  const requestProfileId = useId();
  const modelId = useId();
  const providerOptionsId = useId();

  if (!controller.available) {
    return (
      <div className="provider-settings-card muted-card">
        <div className="panel-section-title">
          <h4>{title}</h4>
          <span>로컬 모드</span>
        </div>
        <p className="muted">서버에 연결하거나 데스크톱 앱에서 엔진을 설정할 수 있어요.</p>
      </div>
    );
  }

  if (!draft || providers.length === 0) {
    return (
      <div className="provider-settings-card">
        <div className="panel-section-title">
          <h4>{title}</h4>
          <span>{controller.loading ? '불러오는 중' : '대기'}</span>
        </div>
        {controller.error && <p className="field-error">{controller.error}</p>}
        <button className="ghost-btn wide" onClick={() => void controller.refresh()} disabled={controller.loading}>
          <RefreshCw size={16} /> 엔진 설정 불러오기
        </button>
      </div>
    );
  }

  const selectedProvider =
    providers.find((provider) => provider.providerId === draft.selectedProviderId) ?? providers[0];
  const requestProfiles =
    scope === 'llm_labeling' ? (selectedProvider.capabilities.supportedRequestProfiles ?? []) : [];
  const configuredModelId = draft.modelByProvider[selectedProvider.providerId]?.trim();
  const selectedCapability =
    selectedProvider.models.find((model) => model.modelId === configuredModelId)?.capabilitySnapshot ??
    selectedProvider.models[0]?.capabilitySnapshot;
  const providerOptions = selectedProvider.kind === 'system_tts' ? [] : providerSettingOptionConfigs(selectedProvider);
  const readyCount = providers.filter(catalogProviderReady).length;
  const selectedSecretName = defaultProviderSecretName(scope, selectedProvider.providerId);
  const selectedSecretKey = selectedSecretName
    ? providerSecretDraftKey(scope, selectedProvider.providerId, selectedSecretName)
    : undefined;
  const selectedSecretStatus = selectedSecretName
    ? (controller.secretStatuses.find(
        (status) =>
          status.scope === scope &&
          status.providerId === selectedProvider.providerId &&
          status.secretName === selectedSecretName,
      ) ?? selectedProvider.secretStatus)
    : undefined;
  // Older servers and desktop builds don't report this status, so they never show the JSON upload.
  const serviceAccountStatus =
    scope === 'tts_synthesis' && !controller.desktopMode && SERVICE_ACCOUNT_PROVIDERS.has(selectedProvider.providerId)
      ? controller.secretStatuses.find(
          (status) =>
            status.scope === scope &&
            status.providerId === selectedProvider.providerId &&
            status.secretName === SERVICE_ACCOUNT_SECRET,
        )
      : undefined;
  const updateSelectedOption = (
    option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
    value: string | number | boolean | undefined,
  ) =>
    controller.updateDraft(scope, (current) =>
      setDraftProviderOption(current, selectedProvider.providerId, option, value),
    );

  return (
    <div className="provider-settings-card">
      <div className="panel-section-title">
        <h4>{title}</h4>
        <span>
          {readyCount} / {providers.length} 사용 가능
        </span>
      </div>
      {controller.error && <p className="field-error">{controller.error}</p>}

      <div className="provider-grid">
        {providers.map((provider) => {
          const ready = catalogProviderReady(provider);
          return (
            <label key={provider.providerId} className={classNames('provider-row', !ready && 'disabled')}>
              <input
                type="checkbox"
                checked={draft.enabledProviderIds.includes(provider.providerId)}
                disabled={!ready}
                onChange={(event) =>
                  controller.updateDraft(scope, (current) =>
                    setDraftProviderEnabled(current, provider.providerId, event.target.checked),
                  )
                }
              />
              <span>
                <strong>{provider.displayName}</strong>
                <small>
                  {provider.providerId} · {providerReadinessLabel(provider)}
                </small>
              </span>
            </label>
          );
        })}
      </div>

      <label className="field-label" htmlFor={defaultProviderId}>
        기본 엔진
      </label>
      <select
        id={defaultProviderId}
        value={draft.defaultProviderId}
        onChange={(event) =>
          controller.updateDraft(scope, (current) => setDraftDefaultProvider(current, event.target.value))
        }
      >
        {providers.map((provider) => (
          <option key={provider.providerId} value={provider.providerId}>
            {provider.displayName} · {providerReadinessLabel(provider)}
          </option>
        ))}
      </select>

      <label className="field-label" htmlFor={selectedProviderId}>
        설정할 엔진
      </label>
      <select
        id={selectedProviderId}
        value={selectedProvider.providerId}
        onChange={(event) =>
          controller.updateDraft(scope, (current) => ({ ...current, selectedProviderId: event.target.value }))
        }
      >
        {providers.map((provider) => (
          <option key={provider.providerId} value={provider.providerId}>
            {provider.displayName}
          </option>
        ))}
      </select>

      {requestProfiles.length > 0 && (
        <>
          <label className="field-label" htmlFor={requestProfileId}>
            요청 프로필
          </label>
          <select
            id={requestProfileId}
            value={requestProfileIdForDraftProvider(draft, selectedProvider)}
            onChange={(event) =>
              controller.updateDraft(scope, (current) =>
                setDraftProviderRequestProfile(current, selectedProvider.providerId, event.target.value),
              )
            }
          >
            {requestProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId} disabled={!profile.enabled}>
                {profile.displayName} - {profile.promptVersion}
              </option>
            ))}
          </select>
        </>
      )}

      {scope === 'llm_labeling' && (
        <label className="provider-option-toggle">
          <input
            type="checkbox"
            checked={autoRepairForDraftProvider(draft, selectedProvider.providerId)}
            onChange={(event) =>
              controller.updateDraft(scope, (current) =>
                setDraftProviderAutoRepair(current, selectedProvider.providerId, event.target.checked),
              )
            }
          />
          <span>
            <strong>Validation 실패 시 자동 repair</strong>
            <small>라벨 검증 실패 때 repair pass를 한 번 더 실행합니다.</small>
          </span>
        </label>
      )}

      <label className="field-label" htmlFor={modelId}>
        모델
      </label>
      <input
        id={modelId}
        className="text-input"
        value={draft.modelByProvider[selectedProvider.providerId] ?? ''}
        placeholder={selectedProvider.models[0]?.modelId ?? '서버 기본값'}
        onChange={(event) =>
          controller.updateDraft(scope, (current) => ({
            ...current,
            modelByProvider: { ...current.modelByProvider, [selectedProvider.providerId]: event.target.value },
          }))
        }
      />
      {selectedCapability && (
        <p className="provider-capability-summary">
          <strong>
            {providerCapabilityFreshnessAt(selectedCapability) === 'verified'
              ? '검증된 제한'
              : providerCapabilityFreshnessAt(selectedCapability) === 'stale'
                ? '만료된 제한'
                : '보수적 추정'}
          </strong>
          <span>
            {selectedCapability.kind === 'llm'
              ? `컨텍스트 ${selectedCapability.maxContextTokens.toLocaleString('ko-KR')} · 출력 ${selectedCapability.maxOutputTokens.toLocaleString('ko-KR')} tokens`
              : `입력 ${(selectedCapability.maxTextCharacters ?? 0).toLocaleString('ko-KR')}자 · ${selectedCapability.maxInputSegments ?? 0}구간`}
          </span>
        </p>
      )}

      {selectedSecretName && selectedProvider.secretPolicy !== 'no_secret_required' && (
        <div className="provider-secret-control">
          <div className="setting-line">
            <h4>{providerSecretDisplayLabel(selectedSecretName)}</h4>
            <span>{providerSecretStatusLabel(selectedSecretStatus)}</span>
          </div>
          <div className="provider-secret-row">
            <input
              className="text-input"
              type={
                selectedSecretName === 'endpoint_url' || selectedSecretName === 'credential_path' ? 'text' : 'password'
              }
              value={selectedSecretKey ? (controller.secretDrafts[selectedSecretKey] ?? '') : ''}
              placeholder={
                selectedSecretStatus?.configured ? '새 값으로 교체' : providerSecretDisplayLabel(selectedSecretName)
              }
              onChange={(event) =>
                selectedSecretKey && controller.updateSecretDraft(selectedSecretKey, event.target.value)
              }
            />
            <button
              className="ghost-btn"
              onClick={() => void controller.testSecret(scope, selectedProvider.providerId, selectedSecretName)}
              disabled={controller.secretBusyKey === selectedSecretKey}
            >
              <Check size={16} /> 확인
            </button>
            <button
              className="primary-btn"
              onClick={() => void controller.saveSecret(scope, selectedProvider.providerId, selectedSecretName)}
              disabled={controller.secretBusyKey === selectedSecretKey}
            >
              <KeyRound size={16} /> 저장
            </button>
            <button
              className="ghost-btn"
              onClick={() => void controller.deleteSecret(scope, selectedProvider.providerId, selectedSecretName)}
              disabled={
                !providerSecretCanDelete(selectedSecretStatus) || controller.secretBusyKey === selectedSecretKey
              }
            >
              <Trash2 size={16} /> 삭제
            </button>
          </div>
          <p className="muted">저장한 키는 다시 보여주거나 동기화하지 않아요.</p>
        </div>
      )}

      {serviceAccountStatus && (
        <ServiceAccountJsonControl
          key={selectedProvider.providerId}
          scope={scope}
          providerId={selectedProvider.providerId}
          status={serviceAccountStatus}
          controller={controller}
        />
      )}

      {providerOptions.length > 0 && (
        <div className="provider-option-controls">
          <div className="setting-line">
            <h4>엔진 옵션</h4>
            <span>{providerOptions.length}</span>
          </div>
          {providerOptions.map((option) => (
            <ProviderOptionControl
              key={option.optionKey}
              option={option}
              value={providerOptionValueForDraftProvider(draft, selectedProvider.providerId, option.optionKey)}
              onChange={(value) => updateSelectedOption(option, value)}
            />
          ))}
        </div>
      )}

      <label className="field-label" htmlFor={providerOptionsId}>
        추가 옵션 JSON
      </label>
      <textarea
        id={providerOptionsId}
        className="provider-options-textarea"
        value={draft.providerOptionsTextByProvider[selectedProvider.providerId] ?? ''}
        spellCheck={false}
        placeholder='{"temperature":0.1}'
        onChange={(event) =>
          controller.updateDraft(scope, (current) => ({
            ...current,
            providerOptionsTextByProvider: {
              ...current.providerOptionsTextByProvider,
              [selectedProvider.providerId]: event.target.value,
            },
          }))
        }
      />

      <div className="provider-settings-actions">
        {scope === 'llm_labeling' && controller.desktopMode && selectedProvider.kind === 'llm' && (
          <button
            className="ghost-btn"
            onClick={() => void controller.runDesktopLLMSample(selectedProvider, draft)}
            disabled={
              controller.analysisRunning ||
              controller.desktopLLMSampleBusyProvider === selectedProvider.providerId ||
              !catalogProviderReady(selectedProvider)
            }
          >
            <Wand2 size={16} /> 샘플 요청
          </button>
        )}
        {scope === 'tts_synthesis' && controller.desktopMode && selectedProvider.kind !== 'system_tts' && (
          <button
            className="ghost-btn"
            onClick={() => void controller.playDesktopTTSSample(selectedProvider, draft)}
            disabled={
              controller.hostedTTSBusy ||
              controller.desktopTTSSampleBusyProvider === selectedProvider.providerId ||
              !catalogProviderReady(selectedProvider)
            }
          >
            <Headphones size={16} /> 샘플 합성
          </button>
        )}
        <button
          className="ghost-btn"
          onClick={() => void controller.refresh()}
          disabled={controller.loading || controller.savingScope === scope}
        >
          <RefreshCw size={16} /> 새로고침
        </button>
        <button
          className="primary-btn"
          onClick={() => void controller.saveSettings(scope)}
          disabled={controller.savingScope === scope}
        >
          <Check size={16} /> 저장
        </button>
      </div>
    </div>
  );
}
