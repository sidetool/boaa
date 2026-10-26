import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TTSConnection, TTSConnectionDiscovery, TTSConnectionsPort } from '../../providers/tts-connections';
import { cx, Segmented, Switch } from '../components/primitives';
import {
  draftFrom,
  emptyDraft,
  formatVoices,
  hostName,
  keyDecisionNeeded,
  PROTOCOL_HINT,
  readDraft,
  TTS_CONNECTION_FIELD_MAX,
  TTS_CONNECTION_LIMITS,
  type Draft,
  type Protocol,
} from './tts-connection-draft';
// The editor borrows the filter form styles; load them even when the filters page was never opened.
import './listen.css';
import './tts-connections.css';

export { formatVoices, parseVoices, TTS_CONNECTION_LIMITS } from './tts-connection-draft';

export interface UiNextTTSConnectionsProps {
  readonly port: TTSConnectionsPort;
  /** A server was saved, toggled or removed: reload the plain voice catalog, keeping the listener's choice. */
  onChanged?(): void;
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const abortError = () => new DOMException('Aborted', 'AbortError');

// A port belongs to one account/session: a new port starts from a fresh list and an empty form.
const portKeys = new WeakMap<TTSConnectionsPort, number>();
let nextPortKey = 0;
const portKey = (port: TTSConnectionsPort) => {
  let key = portKeys.get(port);
  if (key === undefined) portKeys.set(port, (key = ++nextPortKey));
  return key;
};

/** Saved TTS servers (local or OpenAI-compatible), edited in place on the engines page. */
export default function UiNextTTSConnections(props: UiNextTTSConnectionsProps) {
  return <Connections key={portKey(props.port)} {...props} />;
}

function Connections({ port, onChanged }: UiNextTTSConnectionsProps) {
  const [connections, setConnections] = useState<TTSConnection[]>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // undefined = list only; '' = adding; otherwise the id being edited.
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [found, setFound] = useState<TTSConnectionDiscovery>();
  const [probeState, setProbeState] = useState<{ busy?: boolean; error?: string; done?: string }>({});
  const [saveError, setSaveError] = useState<string>();
  const [busy, setBusy] = useState(false);
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

  // The catalog refresh is the parent's business; its failure never turns a finished save into an error.
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
      setConnections(await run((signal) => port.list(signal)));
      setLoading(false);
    } catch (error) {
      if (aborted(error)) return;
      setLoadError(message(error, '저장된 TTS 서버를 불러오지 못했어요.'));
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

  const current = editing ? connections?.find((connection) => connection.id === editing) : undefined;
  const { input, parsed, probeProblem, saveProblem } = readDraft(draft, current);

  const stopProbe = () => {
    probeController.current?.abort();
    probeController.current = undefined;
  };
  const patch = (next: Partial<Draft>) => setDraft((value) => ({ ...value, ...next }));
  // Anything a probe was asked about makes its pending answer stale.
  const patchTarget = (next: Partial<Pick<Draft, 'protocol' | 'url' | 'modelId' | 'apiKey' | 'clearKey' | 'paid'>>) => {
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
  };
  const open = (connection?: TTSConnection) =>
    reset(connection?.id ?? '', connection ? draftFrom(connection) : emptyDraft());
  const close = () => reset(undefined, emptyDraft());

  const probe = async () => {
    if (probeProblem) return setProbeState({ error: probeProblem });
    stopProbe();
    const controller = new AbortController();
    probeController.current = controller;
    setProbeState({ busy: true });
    try {
      const result = await run((signal) => port.probe(input, signal, editing || undefined), controller);
      probeController.current = undefined;
      setFound(result);
      setDraft((value) => ({
        ...value,
        ...(!value.modelId.trim() && result.models.length === 1 ? { modelId: result.models[0] } : {}),
        ...(!value.voices.trim() && result.voices.length
          ? { voices: formatVoices(result.voices.slice(0, TTS_CONNECTION_LIMITS.maxVoices)) }
          : {}),
      }));
      setProbeState({
        done:
          result.models.length || result.voices.length
            ? `연결됐어요. 모델 ${result.models.length}개, 목소리 ${result.voices.length}개를 찾았어요.`
            : '연결됐어요. 이 서버는 모델·목소리 목록을 알려주지 않아요. 서버 문서의 ID를 직접 넣어 주세요.',
      });
    } catch (error) {
      if (aborted(error)) return;
      probeController.current = undefined;
      setProbeState({ error: message(error, '서버에 연결하지 못했어요.') });
    }
  };

  const save = async () => {
    if (saveProblem) return setSaveError(saveProblem);
    stopProbe();
    setProbeState({});
    setBusy(true);
    setSaveError(undefined);
    let saved: TTSConnection;
    try {
      saved = await run((signal) => port.save(input, signal, editing || undefined));
    } catch (error) {
      if (aborted(error)) return;
      setBusy(false);
      return setSaveError(message(error, '저장하지 못했어요.'));
    }
    setBusy(false);
    setConnections((list = []) =>
      list.some((item) => item.id === saved.id)
        ? list.map((item) => (item.id === saved.id ? saved : item))
        : [...list, saved],
    );
    close();
    notify();
  };

  const remove = async () => {
    if (!editing) return;
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
    setConnections((list = []) => list.filter((item) => item.id !== id));
    close();
    notify();
  };

  const toggle = async (connection: TTSConnection, enabled: boolean) => {
    setTogglingId(connection.id);
    setLoadError(undefined);
    let saved: TTSConnection;
    try {
      // No apiKey: the stored key stays as it is.
      const { id, hasApiKey: _hasApiKey, revision: _revision, ...rest } = connection;
      saved = await run((signal) => port.save({ ...rest, enabled }, signal, id));
    } catch (error) {
      if (aborted(error)) return;
      setTogglingId(undefined);
      return setLoadError(message(error, '켜고 끄지 못했어요.'));
    }
    setTogglingId(undefined);
    setConnections((list = []) => list.map((item) => (item.id === saved.id ? saved : item)));
    notify();
  };

  const changeProtocol = (protocol: Protocol) =>
    patchTarget(draft.paidTouched ? { protocol } : { protocol, paid: protocol === 'openai' });

  const hint = PROTOCOL_HINT[draft.protocol];
  const keyNeeded = keyDecisionNeeded(draft, current);
  // The probe note already asks for manual IDs; don't repeat it under the voices.
  const listless = Boolean(found && !found.models.length && !found.voices.length);
  const extraVoices = found?.voices.length && formatVoices(found.voices) !== draft.voices.trim();

  return (
    <section className="un-listen-group un-tts-conn" aria-label="TTS 서버">
      <div className="un-listen-group-head">
        <h3>TTS 서버</h3>
        {editing === undefined && (
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => open()}>
            <Plus size={15} aria-hidden="true" />
            서버 추가
          </button>
        )}
      </div>

      {editing === undefined ? (
        <>
          <p className="un-listen-note">
            로컬 TTS 서버나 OpenAI 호환 TTS 서버를 여러 개 저장할 수 있어요. 켜 둔 서버의 목소리가 서버 목소리 목록에
            나타나요. 연결 정보는 계정에 암호화해 저장하고, 저장하면 바로 적용돼요.
          </p>
          {loadError && (
            <p className="un-filter-help is-error" role="alert">
              {loadError}{' '}
              <button type="button" className="un-listen-link" onClick={() => void load()}>
                다시 시도
              </button>
            </p>
          )}
          {connections === undefined ? (
            !loadError && <p className="un-listen-note">{loading ? '불러오는 중…' : ''}</p>
          ) : connections.length === 0 ? (
            <p className="un-tts-conn-empty">저장된 서버가 없어요.</p>
          ) : (
            <ul className="un-tts-conn-list">
              {connections.map((connection) => (
                <li key={connection.id} className={cx(!connection.enabled && 'is-off')}>
                  <span className="un-tts-conn-text">
                    <b>{connection.name}</b>
                    <small>
                      {connection.protocol === 'openai' ? 'OpenAI 호환' : '로컬'} · {connection.modelId} · 목소리{' '}
                      {connection.voices.length}개{connection.paid ? ' · 유료 API' : ''}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label={`${connection.name} 수정`}
                    onClick={() => open(connection)}
                  >
                    <Pencil size={15} />
                  </button>
                  <Switch
                    label={`${connection.name} 사용`}
                    checked={connection.enabled}
                    disabled={togglingId === connection.id}
                    onChange={(enabled) => void toggle(connection, enabled)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form
          className="un-filter un-tts-conn-editor"
          aria-label={editing ? '서버 수정' : '서버 추가'}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Segmented
            label="서버 종류"
            value={draft.protocol}
            options={[
              { value: 'local', label: '로컬 서버' },
              { value: 'openai', label: 'OpenAI 호환' },
            ]}
            onChange={changeProtocol}
          />
          <p className="un-filter-help">{hint.note}</p>

          <div className="un-filter-fields un-tts-conn-fields">
            <label className="is-wide">
              <span>이름</span>
              <input
                value={draft.name}
                placeholder={hostName(draft.url) || '예: 집 PC'}
                maxLength={TTS_CONNECTION_FIELD_MAX.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </label>
            <label className="is-wide">
              <span>주소</span>
              <input
                value={draft.url}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={hint.url}
                maxLength={TTS_CONNECTION_FIELD_MAX.url}
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
                  current?.hasApiKey && !draft.clearKey && !keyNeeded ? '저장된 키 유지 · 바꿀 때만 입력' : ''
                }
                maxLength={TTS_CONNECTION_FIELD_MAX.apiKey}
                onChange={(event) => patchTarget({ apiKey: event.target.value, clearKey: false })}
              />
            </label>
          </div>
          {current?.hasApiKey && (
            <label className="un-filter-check">
              <input
                type="checkbox"
                checked={draft.clearKey}
                onChange={(event) => patchTarget({ clearKey: event.target.checked, apiKey: '' })}
              />
              <span>저장된 API 키 지우기</span>
            </label>
          )}
          {keyNeeded && (
            <p className="un-filter-help is-error" role="note">
              주소가 바뀌어 저장된 API 키는 새 주소로 보내지 않아요. 새 키를 넣거나 저장된 키 지우기를 고르세요.
            </p>
          )}

          <div className="un-tts-conn-probe">
            <button
              type="button"
              className="un-btn is-ghost is-sm"
              disabled={!hostName(draft.url) || probeState.busy}
              aria-busy={probeState.busy || undefined}
              onClick={() => void probe()}
            >
              {probeState.busy ? <RefreshCw size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}
              {probeState.busy ? '확인 중' : '연결 확인'}
            </button>
            <small>음성을 만들지 않고 주소와 모델·목소리 목록만 확인해요.</small>
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
                placeholder={draft.protocol === 'openai' ? '예: tts-1' : '서버가 쓰는 모델 이름'}
                maxLength={TTS_CONNECTION_FIELD_MAX.modelId}
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

          <label className="un-tts-conn-voices">
            <span>목소리</span>
            <textarea
              rows={4}
              value={draft.voices}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={'한 줄에 하나씩: ID, 표시 이름, 언어\n예: alloy, 차분한 목소리, ko'}
              onChange={(event) => patch({ voices: event.target.value })}
            />
          </label>
          <p className={cx('un-filter-help', parsed.error && 'is-error')}>
            {parsed.error ??
              `목소리 ${parsed.voices.length}개 · 최대 ${TTS_CONNECTION_LIMITS.maxVoices}개.${listless ? '' : ' 목록을 알려주지 않는 서버는 직접 넣어 주세요.'}`}{' '}
            {extraVoices ? (
              <button
                type="button"
                className="un-listen-link"
                onClick={() => patch({ voices: formatVoices(found!.voices.slice(0, TTS_CONNECTION_LIMITS.maxVoices)) })}
              >
                찾은 목소리 {Math.min(found!.voices.length, TTS_CONNECTION_LIMITS.maxVoices)}개로 바꾸기
              </button>
            ) : null}
          </p>

          <label className="un-filter-check">
            <input
              type="checkbox"
              checked={draft.paid}
              onChange={(event) => patch({ paid: event.target.checked, paidTouched: true })}
            />
            <span>
              사용량 요금이 있는 서버
              <small>켜 두면 이 서버 목소리를 고를 때 요금 안내를 보여줘요.</small>
            </span>
          </label>
          <label className="un-filter-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            <span>목소리 목록에 보이기</span>
          </label>

          <details className="un-tts-conn-advanced">
            <summary>고급 설정</summary>
            <div className="un-filter-fields">
              <label>
                <span>한 번에 보낼 최대 글자 수</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={TTS_CONNECTION_LIMITS.maxCharacters}
                  value={draft.maxInputCharacters}
                  onChange={(event) => patch({ maxInputCharacters: event.target.value })}
                />
              </label>
              <label>
                <span>나눠 보낼 최대 구간 수</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={TTS_CONNECTION_LIMITS.maxSegments}
                  value={draft.maxInputSegments}
                  onChange={(event) => patch({ maxInputSegments: event.target.value })}
                />
              </label>
            </div>
            <p className="un-filter-help">
              낭독할 한 덩어리가 글자 수보다 길면 구간 수 이하로 나눠 엔진에 차례로 보내요. 보통은 기본값(
              {TTS_CONNECTION_LIMITS.defaultCharacters}자·{TTS_CONNECTION_LIMITS.defaultSegments}구간)이면 돼요. 서버가
              긴 요청을 거절하면 글자 수를 줄이세요. 최대 {TTS_CONNECTION_LIMITS.maxCharacters}자·
              {TTS_CONNECTION_LIMITS.maxSegments}구간.
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
                <span className="un-tts-conn-confirm" role="group" aria-label="서버 삭제 확인">
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
              <button type="submit" className="un-btn is-primary is-sm" disabled={busy} aria-busy={busy || undefined}>
                {busy ? '저장 중' : '저장'}
              </button>
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
