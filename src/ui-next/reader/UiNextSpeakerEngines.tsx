import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SpeakerEngine, SpeakerEngineDiscovery, SpeakerEnginesPort } from '../../providers/speaker-engine';
import { cx, Segmented, Switch } from '../components/primitives';
import SpeakerVertexFields from './SpeakerVertexFields';
import {
  DEFAULT_SPEAKER_ENGINE_URL,
  draftFrom,
  emptyDraft,
  hostName,
  PROTOCOL_HINT,
  readDraft,
  SPEAKER_ENGINE_FIELD_MAX,
  SPEAKER_ENGINE_OUTPUT,
  type Draft,
  type Protocol,
  type Reasoning,
  type TokenLimitParameter,
} from './speaker-engine-draft';
// The editor borrows the filter and TTS server form styles.
import './listen.css';
import './tts-connections.css';
import './speaker-generation.css';

export interface UiNextSpeakerEnginesProps {
  readonly port: SpeakerEnginesPort;
  /** A model was saved, toggled or removed: the generation page reloads its list, keeping its choice. */
  onChanged?(): void;
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const abortError = () => new DOMException('Aborted', 'AbortError');

const PROTOCOL_LABEL: Record<Protocol, string> = { openai: 'OpenAI 호환', gemini: 'Gemini', vertex: 'Vertex AI' };
const TOKEN_LIMIT_LABEL: Record<TokenLimitParameter, string> = {
  max_tokens: 'max_tokens · 호환형',
  max_completion_tokens: 'max_completion_tokens · 최신 OpenAI',
};
const REASONING_LABEL: Record<Reasoning | '', string> = {
  '': '보내지 않음',
  low: '낮음',
  medium: '보통',
  high: '높음',
};

// A port belongs to one account/session: a new port starts from a fresh list and an empty form.
const portKeys = new WeakMap<SpeakerEnginesPort, number>();
let nextPortKey = 0;
const portKey = (port: SpeakerEnginesPort) => {
  let key = portKeys.get(port);
  if (key === undefined) portKeys.set(port, (key = ++nextPortKey));
  return key;
};

/** Analysis models for 화자별 미리 생성하기. Kept apart from TTS voices; secrets go to the server only. */
export default function UiNextSpeakerEngines(props: UiNextSpeakerEnginesProps) {
  return <Engines key={portKey(props.port)} {...props} />;
}

function Engines({ port, onChanged }: UiNextSpeakerEnginesProps) {
  const [engines, setEngines] = useState<SpeakerEngine[]>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // undefined = list only; '' = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [found, setFound] = useState<SpeakerEngineDiscovery>();
  const [probeState, setProbeState] = useState<{ busy?: boolean; error?: string; done?: string }>({});
  const [saveError, setSaveError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [fileReading, setFileReading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [togglingId, setTogglingId] = useState<string>();
  const controllers = useRef(new Set<AbortController>());
  const probeController = useRef<AbortController>(undefined);

  /** Runs one request; once aborted (unmount, closed form, changed draft) it never resolves into state. */
  const run = async <T,>(task: (signal: AbortSignal) => Promise<T>, controller = new AbortController()) => {
    controllers.current.add(controller);
    try {
      const result = await task(controller.signal);
      if (controller.signal.aborted) throw abortError();
      return result;
    } catch (error) {
      throw controller.signal.aborted ? abortError() : error;
    } finally {
      controllers.current.delete(controller);
    }
  };

  const notify = () => {
    try {
      onChanged?.();
    } catch {
      /* the mutation already succeeded */
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      setEngines(await run((signal) => port.list(signal)));
      setLoading(false);
    } catch (error) {
      if (aborted(error)) return;
      setLoadError(message(error, '분석 모델 연결을 불러오지 못했어요.'));
      setLoading(false);
    }
  };

  useEffect(() => {
    const live = controllers.current;
    void load();
    return () => {
      for (const controller of live) controller.abort();
      live.clear();
    };
    // Mounted once per port (see the keyed wrapper).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = editing ? engines?.find((engine) => engine.id === editing) : undefined;
  const { input, decisions, probeProblem, saveProblem } = readDraft(draft, current);

  const stopProbe = () => {
    probeController.current?.abort();
    probeController.current = undefined;
  };
  const patch = (next: Partial<Draft>) => setDraft((value) => ({ ...value, ...next }));
  // Anything a check was asked about makes its pending answer stale.
  const patchTarget = (
    next: Partial<
      Pick<
        Draft,
        | 'purpose'
        | 'protocol'
        | 'url'
        | 'apiKey'
        | 'clearKey'
        | 'engineUrl'
        | 'engineToken'
        | 'clearToken'
        | 'modelId'
        | 'serviceAccountJson'
        | 'projectId'
        | 'location'
        | 'pdfInput'
      >
    >,
  ) => {
    if (probeController.current) {
      stopProbe();
      setProbeState({});
    }
    patch(next);
  };

  const reset = (id: string | undefined, next: Draft) => {
    stopProbe();
    setEditing(id);
    setDraft(next);
    setFound(undefined);
    setProbeState({});
    setSaveError(undefined);
    setConfirmRemove(false);
    setFileReading(false);
  };
  const open = (engine?: SpeakerEngine) => reset(engine?.id ?? '', engine ? draftFrom(engine) : emptyDraft());
  const close = () => reset(undefined, emptyDraft());

  const probe = async () => {
    if (fileReading) return;
    if (probeProblem) return setProbeState({ error: probeProblem });
    stopProbe();
    const controller = new AbortController();
    probeController.current = controller;
    setProbeState({ busy: true });
    try {
      const result = await run((signal) => port.probe(input, signal, editing || undefined), controller);
      probeController.current = undefined;
      setFound(result);
      setDraft((value) =>
        !value.modelId.trim() && result.models.length === 1 ? { ...value, modelId: result.models[0]! } : value,
      );
      setProbeState({
        done: result.models.length
          ? `연결됐어요. 모델 ${result.models.length}개를 찾았어요.`
          : '연결됐어요. 모델 목록을 알려주지 않아 모델 ID를 직접 넣어 주세요.',
      });
    } catch (error) {
      if (aborted(error)) return;
      probeController.current = undefined;
      setProbeState({ error: message(error, '연결하지 못했어요.') });
    }
  };

  const save = async () => {
    if (busy || fileReading) return;
    if (saveProblem) return setSaveError(saveProblem);
    stopProbe();
    setProbeState({});
    setBusy(true);
    setSaveError(undefined);
    let saved: SpeakerEngine;
    try {
      saved = await run((signal) => port.save(input, signal, editing || undefined));
    } catch (error) {
      if (aborted(error)) return;
      setBusy(false);
      return setSaveError(message(error, '저장하지 못했어요.'));
    }
    setBusy(false);
    setEngines((list = []) =>
      list.some((item) => item.id === saved.id)
        ? list.map((item) => (item.id === saved.id ? saved : item))
        : [...list, saved],
    );
    close();
    notify();
  };

  const remove = async () => {
    if (!editing || busy) return;
    const id = editing;
    stopProbe();
    setBusy(true);
    setSaveError(undefined);
    try {
      await run((signal) => port.remove(id, signal));
    } catch (error) {
      if (aborted(error)) return;
      setBusy(false);
      return setSaveError(message(error, '삭제하지 못했어요.'));
    }
    setBusy(false);
    setEngines((list = []) => list.filter((item) => item.id !== id));
    close();
    notify();
  };

  const toggle = async (engine: SpeakerEngine, enabled: boolean) => {
    if (togglingId) return;
    setTogglingId(engine.id);
    setLoadError(undefined);
    let saved: SpeakerEngine;
    try {
      // No apiKey or engineToken: the stored secrets stay as they are.
      const {
        id,
        hasApiKey: _key,
        hasEngineToken: _token,
        hasServiceAccount: _json,
        revision: _revision,
        ...rest
      } = engine;
      saved = await run((signal) => port.save({ ...rest, enabled }, signal, id));
    } catch (error) {
      if (aborted(error)) return;
      setTogglingId(undefined);
      return setLoadError(message(error, '켜고 끄지 못했어요.'));
    }
    setTogglingId(undefined);
    setEngines((list = []) => list.map((item) => (item.id === saved.id ? saved : item)));
    notify();
  };

  const hint = PROTOCOL_HINT[draft.protocol];
  const advancedChanged =
    draft.engineUrl.trim() !== DEFAULT_SPEAKER_ENGINE_URL ||
    Boolean(current?.hasEngineToken) ||
    draft.maxOutputTokens !== String(SPEAKER_ENGINE_OUTPUT.default) ||
    Boolean(draft.reasoning) ||
    (draft.protocol === 'openai' && draft.tokenLimitParameter !== 'max_tokens');

  return (
    <section className="un-listen-group un-tts-conn" aria-label="분석 모델">
      <div className="un-listen-group-head">
        <h3>{editing === undefined ? '연결한 모델' : current ? '연결 수정' : '연결 추가'}</h3>
        {editing === undefined && (
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => open()}>
            <Plus size={15} aria-hidden="true" />
            모델 추가
          </button>
        )}
      </div>

      {editing === undefined ? (
        <>
          <p className="un-listen-note">
            화자를 찾는 모델과 목소리를 고르는 모델을 따로 연결할 수 있어요. API 서비스와 로컬 모델 모두 지원하고, 접속
            정보는 계정에 암호화해 저장해요.
          </p>
          {loadError && (
            <p className="un-filter-help is-error" role="alert">
              {loadError}{' '}
              <button type="button" className="un-listen-link" onClick={() => void load()}>
                다시 시도
              </button>
            </p>
          )}
          {engines === undefined ? (
            !loadError && <p className="un-listen-note">{loading ? '불러오는 중…' : ''}</p>
          ) : engines.length === 0 ? (
            <p className="un-tts-conn-empty">연결한 분석 모델이 없어요.</p>
          ) : (
            <ul className="un-tts-conn-list">
              {engines.map((engine) => (
                <li key={engine.id} className={cx(!engine.enabled && 'is-off')}>
                  <span className="un-tts-conn-text">
                    <b>{engine.name}</b>
                    <small>
                      {engine.purpose === 'casting' ? '목소리 선정' : '화자 분석'} · {PROTOCOL_LABEL[engine.protocol]} ·{' '}
                      {engine.modelId}
                      {hostName(engine.url) ? ` · ${hostName(engine.url)}` : ''}
                      {engine.paid ? ' · 유료 API' : ''}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${engine.name} 수정`}
                    onClick={() => open(engine)}
                  >
                    <Pencil size={15} />
                  </button>
                  <Switch
                    label={`${engine.name} 사용`}
                    checked={engine.enabled}
                    disabled={togglingId === engine.id}
                    onChange={(enabled) => void toggle(engine, enabled)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form
          className="un-filter un-tts-conn-editor un-speaker-engine-form"
          aria-label={editing ? '분석 모델 수정' : '분석 모델 추가'}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Segmented
            label="API 종류"
            value={draft.protocol}
            options={[
              { value: 'openai', label: PROTOCOL_LABEL.openai },
              { value: 'gemini', label: PROTOCOL_LABEL.gemini },
              { value: 'vertex', label: PROTOCOL_LABEL.vertex },
            ]}
            onChange={(protocol) => {
              setFileReading(false);
              setFound(undefined);
              patchTarget({ protocol, serviceAccountJson: '', ...(protocol === 'openai' ? { pdfInput: false } : {}) });
            }}
          />
          <p className="un-filter-help">{hint.note}</p>

          <div className="un-filter-fields un-tts-conn-fields">
            <label className="is-wide">
              <span>모델 용도</span>
              <select
                value={draft.purpose}
                onChange={(e) => patchTarget({ purpose: e.target.value as Draft['purpose'] })}
              >
                <option value="analysis">화자 분석</option>
                <option value="casting">목소리 선정</option>
              </select>
            </label>
            <label className="is-wide">
              <span>이름</span>
              <input
                value={draft.name}
                placeholder={draft.modelId.trim() || hostName(draft.url) || '예: 집 PC 모델'}
                maxLength={SPEAKER_ENGINE_FIELD_MAX.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            {draft.protocol === 'vertex' ? (
              <SpeakerVertexFields
                key={editing}
                draft={draft}
                stored={!!current?.hasServiceAccount}
                patch={patchTarget}
                onReading={(value) => {
                  setFileReading(value);
                  if (value) {
                    stopProbe();
                    setProbeState({});
                  }
                }}
              />
            ) : (
              <>
                <label className="is-wide">
                  <span>모델 API 주소</span>
                  <input
                    value={draft.url}
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={hint.url}
                    maxLength={SPEAKER_ENGINE_FIELD_MAX.url}
                    onChange={(event) => patchTarget({ url: event.target.value })}
                  />
                </label>
                <label className="is-wide">
                  <span>API 키 (선택)</span>
                  <input
                    type="password"
                    value={draft.apiKey}
                    autoComplete="new-password"
                    placeholder={
                      current?.hasApiKey && !draft.clearKey && !decisions.apiKey
                        ? '저장된 키 유지 · 바꿀 때만 입력'
                        : ''
                    }
                    maxLength={SPEAKER_ENGINE_FIELD_MAX.apiKey}
                    onChange={(event) => patchTarget({ apiKey: event.target.value, clearKey: false })}
                  />
                </label>
              </>
            )}
          </div>
          {draft.protocol !== 'vertex' && current?.hasApiKey && (
            <label className="un-filter-check">
              <input
                type="checkbox"
                checked={draft.clearKey}
                onChange={(event) => patchTarget({ clearKey: event.target.checked, apiKey: '' })}
              />
              <span>저장된 API 키 지우기</span>
            </label>
          )}
          {decisions.apiKey && (
            <p className="un-filter-help is-error" role="note">
              주소가 바뀌어 저장된 API 키는 새 주소로 보내지 않아요. 새 키를 넣거나 저장된 키 지우기를 고르세요.
            </p>
          )}

          {draft.protocol !== 'openai' && (
            <label className="un-filter-check">
              <input type="checkbox" checked={draft.pdfInput} onChange={(e) => patch({ pdfInput: e.target.checked })} />
              <span>
                PDF로 압축해서 보내기
                <small className="un-filter-help">
                  입력 내용을 요약 없이 텍스트 PDF로 보내요. 입력 토큰 비용을 줄일 수 있지만 모델마다 절감 폭과 판정
                  품질이 달라요. PDF를 지원하는 모델에서 사용하세요.
                </small>
              </span>
            </label>
          )}

          <div className="un-tts-conn-probe">
            <button
              type="button"
              className="un-btn is-ghost is-sm"
              disabled={
                (draft.protocol === 'vertex' ? !!probeProblem : !hostName(draft.url)) || probeState.busy || fileReading
              }
              aria-busy={probeState.busy || undefined}
              onClick={() => void probe()}
            >
              {probeState.busy ? <RefreshCw size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
              {probeState.busy ? '확인 중' : '연결 확인'}
            </button>
            <small>
              {draft.purpose === 'casting'
                ? '목소리를 선정하지 않고 모델 목록만 확인해요.'
                : '분석은 하지 않고 분석 서비스와 모델 목록만 확인해요.'}
            </small>
          </div>
          {probeState.error && (
            <p className="un-filter-help is-error" role="alert">
              {probeState.error}
            </p>
          )}
          {probeState.done && (
            <p className="un-filter-help" role="status">
              {probeState.done}
            </p>
          )}

          <div className="un-filter-fields un-tts-conn-fields">
            <label className="is-wide">
              <span>모델 ID</span>
              <input
                value={draft.modelId}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={hint.model}
                maxLength={SPEAKER_ENGINE_FIELD_MAX.modelId}
                onChange={(event) => patchTarget({ modelId: event.target.value })}
              />
            </label>
          </div>
          {found && found.models.length > 1 && (
            <div className="un-listen-chips un-tts-conn-models" role="radiogroup" aria-label="찾은 모델">
              {found.models.map((model) => (
                <button
                  key={model}
                  type="button"
                  role="radio"
                  aria-checked={draft.modelId === model}
                  className={cx(draft.modelId === model && 'is-active')}
                  onClick={() => patchTarget({ modelId: model })}
                >
                  {model}
                </button>
              ))}
            </div>
          )}

          <label className="un-filter-check">
            <input type="checkbox" checked={draft.paid} onChange={(event) => patch({ paid: event.target.checked })} />
            <span>
              사용량 요금이 있는 모델
              <small>켜 두면 만들기 전에 요금 안내를 보여줘요. 로컬 모델이면 꺼도 돼요.</small>
            </span>
          </label>
          <label className="un-filter-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span>모델 목록에 보이기</span>
          </label>

          <details className="un-tts-conn-advanced" open={advancedChanged || decisions.engineToken || undefined}>
            <summary>고급 설정</summary>
            <div className="un-filter-fields un-tts-conn-fields">
              <label>
                <span>최대 출력 토큰</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={SPEAKER_ENGINE_OUTPUT.min}
                  max={SPEAKER_ENGINE_OUTPUT.max}
                  step={1024}
                  value={draft.maxOutputTokens}
                  onChange={(event) => patch({ maxOutputTokens: event.target.value })}
                />
              </label>
              <label>
                <span>추론 강도</span>
                <select
                  value={draft.reasoning}
                  onChange={(event) => patch({ reasoning: event.target.value as Reasoning | '' })}
                >
                  {(Object.keys(REASONING_LABEL) as (Reasoning | '')[]).map((value) => (
                    <option key={value} value={value}>
                      {REASONING_LABEL[value]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.protocol === 'openai' && (
                <label className="is-wide">
                  <span>출력 한도 방식</span>
                  <select
                    value={draft.tokenLimitParameter}
                    onChange={(event) => patch({ tokenLimitParameter: event.target.value as TokenLimitParameter })}
                  >
                    {(Object.keys(TOKEN_LIMIT_LABEL) as TokenLimitParameter[]).map((value) => (
                      <option key={value} value={value}>
                        {TOKEN_LIMIT_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="is-wide" hidden={draft.purpose === 'casting'}>
                <span>분석 서비스 주소</span>
                <input
                  value={draft.engineUrl}
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={DEFAULT_SPEAKER_ENGINE_URL}
                  maxLength={SPEAKER_ENGINE_FIELD_MAX.url}
                  onChange={(event) => patchTarget({ engineUrl: event.target.value })}
                />
              </label>
              <label className="is-wide" hidden={draft.purpose === 'casting'}>
                <span>분석 서비스 토큰 (선택)</span>
                <input
                  type="password"
                  value={draft.engineToken}
                  autoComplete="new-password"
                  placeholder={
                    current?.hasEngineToken && !draft.clearToken && !decisions.engineToken
                      ? '저장된 토큰 유지 · 바꿀 때만 입력'
                      : ''
                  }
                  maxLength={SPEAKER_ENGINE_FIELD_MAX.engineToken}
                  onChange={(event) => patchTarget({ engineToken: event.target.value, clearToken: false })}
                />
              </label>
            </div>
            {current?.hasEngineToken && (
              <label className="un-filter-check">
                <input
                  type="checkbox"
                  checked={draft.clearToken}
                  onChange={(event) => patchTarget({ clearToken: event.target.checked, engineToken: '' })}
                />
                <span>저장된 토큰 지우기</span>
              </label>
            )}
            {decisions.engineToken && (
              <p className="un-filter-help is-error" role="note">
                분석 서비스 주소가 바뀌어 저장된 토큰은 새 주소로 보내지 않아요. 새 토큰을 넣거나 저장된 토큰 지우기를
                고르세요.
              </p>
            )}
            <p className="un-filter-help">
              {draft.purpose !== 'casting' &&
                '분석 서비스는 BOAA와 함께 실행하는 별도 컨테이너예요. 다른 곳에서 실행할 때만 주소를 바꾸세요. '}
              출력 토큰은 {SPEAKER_ENGINE_OUTPUT.min}~{SPEAKER_ENGINE_OUTPUT.max}, 기본 {SPEAKER_ENGINE_OUTPUT.default}.
              {draft.protocol === 'openai' &&
                ' 모델이 max_tokens를 거절하면 출력 한도 방식을 max_completion_tokens로 바꾸세요.'}
            </p>
          </details>

          {saveError && (
            <p className="un-filter-help is-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="un-filter-editor-foot">
            {editing &&
              (confirmRemove ? (
                <span className="un-tts-conn-confirm" role="group" aria-label="분석 모델 삭제 확인">
                  <small>삭제할까요?</small>
                  <button
                    type="button"
                    className="un-btn is-danger is-sm"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    삭제
                  </button>
                  <button type="button" className="un-btn is-text is-sm" onClick={() => setConfirmRemove(false)}>
                    아니요
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="un-btn is-text is-sm"
                  disabled={busy}
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  삭제
                </button>
              ))}
            <span className="un-filter-actions">
              <button type="button" className="un-btn is-ghost is-sm" disabled={busy} onClick={close}>
                취소
              </button>
              <button
                type="submit"
                className="un-btn is-primary is-sm"
                disabled={busy || fileReading}
                aria-busy={busy || fileReading || undefined}
              >
                {busy ? '저장 중' : '저장'}
              </button>
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
