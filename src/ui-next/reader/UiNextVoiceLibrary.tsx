import { useEffect, useRef, useState } from 'react';
import { Pencil, Play, Plus, RefreshCw, Square, Trash2, WandSparkles } from 'lucide-react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type {
  LibraryVoice,
  VoiceLibraryInput,
  VoiceLibraryPort,
  VoiceDesignProvider,
} from '../../providers/voice-library';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import { Switch } from '../components/primitives';
import './listen.css';
import './tts-connections.css';
import './speaker-generation.css';
import './voice-library.css';

export default function UiNextVoiceLibrary({
  port,
  voices,
  onChanged,
  beforePreview,
}: {
  port: VoiceLibraryPort;
  voices: readonly PlainTTSVoice[];
  onChanged(): void;
  beforePreview?(): void | Promise<void>;
}) {
  const [rows, setRows] = useState<LibraryVoice[]>();
  const [designers, setDesigners] = useState<VoiceDesignProvider[]>([]);
  const [editing, setEditing] = useState<LibraryVoice | 'add' | 'design'>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string>();
  const [remove, setRemove] = useState<string>();
  const [query, setQuery] = useState('');
  const lifetime = useRef(new AbortController());
  const loadVersion = useRef(0);
  const sampleRun = useRef<AbortController>();
  const working = useRef(false);
  const [audio] = useState(() => new BrowserAudioSession());
  const load = async () => {
    const signal = lifetime.current.signal;
    const version = ++loadVersion.current;
    try {
      const data = await port.list(signal);
      if (signal.aborted || version !== loadVersion.current) return;
      setRows(data.voices);
      setDesigners(data.designers);
      setError(undefined);
    } catch (e) {
      if (!signal.aborted && version === loadVersion.current)
        setError(e instanceof Error ? e.message : '목소리를 불러오지 못했어요.');
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setRows(undefined);
    setDesigners([]);
    setEditing(undefined);
    setPlaying(undefined);
    setBusy(false);
    working.current = false;
    void load();
    return () => {
      controller.abort();
      sampleRun.current?.abort();
      audio.stop();
    };
    // The parent keys this page by account and book.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);
  const act = async (task: () => Promise<unknown>, close = false) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(undefined);
    const signal = lifetime.current.signal;
    try {
      await task();
      if (signal.aborted) return;
      if (close) setEditing(undefined);
      setRemove(undefined);
      await load();
      if (signal.aborted) return;
      try {
        onChanged();
      } catch {
        /* persisted */
      }
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : '저장하지 못했어요.');
    } finally {
      if (!signal.aborted) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  const preview = async (row: LibraryVoice) => {
    sampleRun.current?.abort();
    audio.stop();
    setError(undefined);
    if (playing === row.id) {
      setPlaying(undefined);
      return;
    }
    const c = new AbortController();
    sampleRun.current = c;
    setPlaying(row.id);
    try {
      await beforePreview?.();
      if (c.signal.aborted) return;
      const blob = await port.sample(row.id, c.signal);
      if (c.signal.aborted) return;
      if (!(await audio.playBlob(blob)) && !c.signal.aborted) throw new Error('미리듣기를 재생하지 못했어요.');
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof Error ? e.message : '미리듣기를 불러오지 못했어요.');
    } finally {
      if (sampleRun.current === c && !c.signal.aborted) setPlaying(undefined);
    }
  };
  return (
    <section className="un-voice-library un-cast" aria-label="목소리 보관함">
      <p className="un-book-note">
        목소리를 한 번 준비해 두면 여러 작품에서 사용할 수 있어요. 별칭이나 설명을 바꿔도 이미 만든 음성은 그대로예요.
      </p>
      {error && (
        <p role="alert" className="un-book-error">
          {error}
        </p>
      )}
      {editing ? (
        <VoiceEditor
          key={typeof editing === 'string' ? editing : editing.id}
          value={typeof editing === 'string' ? undefined : editing}
          design={editing === 'design'}
          voices={voices}
          designers={designers}
          busy={busy}
          onCancel={() => setEditing(undefined)}
          onSave={(input) =>
            void act(
              () => port.save(input, lifetime.current.signal, typeof editing === 'string' ? undefined : editing.id),
              true,
            )
          }
          onDesign={(input) => void act(() => port.design(input, lifetime.current.signal), true)}
        />
      ) : (
        <>
          <div className="un-book-actions">
            <button type="button" className="un-btn is-ghost is-sm" onClick={() => setEditing('add')}>
              <Plus size={16} />
              기존 목소리 추가
            </button>
            {designers.length > 0 && (
              <button type="button" className="un-btn is-ghost is-sm" onClick={() => setEditing('design')}>
                <WandSparkles size={16} />
                설명으로 만들기
              </button>
            )}
            <button
              type="button"
              className="un-icon-btn is-sm"
              onClick={() => void load()}
              aria-label="보관함 새로고침"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <label className="un-cast-field">
            <span>목소리 찾기</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="별칭, 음색, 설명, ID" />
          </label>
          {!rows ? (
            <p className="un-book-note">불러오는 중…</p>
          ) : rows.length === 0 ? (
            <p className="un-book-note is-box">
              아직 보관한 목소리가 없어요. 기본 목소리로도 자동 배정할 수 있고, 자주 쓸 목소리를 추가하면 음색과
              설명까지 참고해 골라 줘요.
            </p>
          ) : (
            <ul className="un-book-list">
              {rows
                .filter((r) =>
                  `${r.alias} ${r.timbre} ${r.description} ${r.providerVoiceId}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((row) => (
                  <li key={row.id} className="un-book-item">
                    <div className="un-book-item-head">
                      <b>{row.alias}</b>
                      <Switch
                        label={`${row.alias} 자동 배정에 사용`}
                        checked={row.enabled}
                        disabled={busy}
                        onChange={() =>
                          void act(() => port.save({ ...row, enabled: !row.enabled }, lifetime.current.signal, row.id))
                        }
                      />
                    </div>
                    <small className="un-book-meta">
                      {row.timbre || '음색 설명 없음'} · {row.language || '언어 미지정'}
                      {!row.available ? ' · 연결 확인 필요' : ''}
                    </small>
                    {row.description && <p className="un-book-note">{row.description}</p>}
                    <small className="un-voice-id">
                      {row.providerId} · {row.providerVoiceId}
                    </small>
                    <div className="un-book-actions">
                      <button
                        type="button"
                        className="un-btn is-ghost is-sm"
                        disabled={!row.available && !row.sampleAvailable}
                        onClick={() => void preview(row)}
                      >
                        {playing === row.id ? <Square size={15} /> : <Play size={15} />}미리듣기
                      </button>
                      <button
                        type="button"
                        className="un-btn is-text is-sm"
                        disabled={busy}
                        onClick={() => setEditing(row)}
                      >
                        <Pencil size={15} />
                        수정
                      </button>
                      <button
                        type="button"
                        className="un-icon-btn is-sm"
                        disabled={busy}
                        aria-label={`${row.alias} 삭제`}
                        onClick={() => setRemove(row.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {remove === row.id && (
                      <div className="un-book-confirm">
                        <p>보관함에서 지울까요? 이미 만든 음성과 제공자에 등록된 목소리는 지우지 않아요.</p>
                        <div className="un-book-actions">
                          <button
                            type="button"
                            className="un-btn is-sm"
                            disabled={busy}
                            onClick={() => void act(() => port.remove(row.id, lifetime.current.signal))}
                          >
                            삭제
                          </button>
                          <button type="button" className="un-btn is-text is-sm" onClick={() => setRemove(undefined)}>
                            취소
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          )}
          <p className="un-book-note">
            미리듣기 음성이 없으면 짧은 샘플을 만들며, 연결한 API의 사용 요금이 발생할 수 있어요.
          </p>
        </>
      )}
    </section>
  );
}
function VoiceEditor({
  value,
  design,
  voices,
  designers,
  busy,
  onCancel,
  onSave,
  onDesign,
}: {
  value?: LibraryVoice;
  design: boolean;
  voices: readonly PlainTTSVoice[];
  designers: VoiceDesignProvider[];
  busy: boolean;
  onCancel(): void;
  onSave(v: VoiceLibraryInput): void;
  onDesign(v: Parameters<VoiceLibraryPort['design']>[0]): void;
}) {
  const [voiceId, setVoiceId] = useState(value?.voiceId ?? voices[0]?.id ?? '');
  const [alias, setAlias] = useState(value?.alias ?? (design ? '' : (voices[0]?.label ?? '')));
  const [timbre, setTimbre] = useState(value?.timbre ?? '');
  const [description, setDescription] = useState(value?.description ?? (design ? '' : (voices[0]?.description ?? '')));
  const [language, setLanguage] = useState(value?.language ?? 'ko');
  const [providerId, setProviderId] = useState(designers[0]?.id ?? '');
  const [modelId, setModelId] = useState(designers[0]?.modelId ?? '');
  const [ack, setAck] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const edit = () => {
    setAck(false);
    setRequestId(crypto.randomUUID());
  };
  const designer = designers.find((d) => d.id === providerId);
  const valid =
    alias.trim() && (design ? designer && modelId.trim() && description.trim() && (!designer.paid || ack) : voiceId);
  return (
    <div className="un-filter un-tts-conn-editor un-speaker-engine-form">
      <h3>{design ? '설명으로 목소리 만들기' : value ? '목소리 수정' : '목소리 추가'}</h3>
      <fieldset disabled={busy} className="un-voice-fields">
        {design ? (
          <>
            <label className="un-cast-field">
              <span>TTS 연결</span>
              <select
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModelId(designers.find((d) => d.id === e.target.value)?.modelId ?? '');
                  edit();
                }}
              >
                {designers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="un-cast-field">
              <span>목소리 제작 모델 ID</span>
              <input
                value={modelId}
                maxLength={200}
                onChange={(e) => {
                  setModelId(e.target.value);
                  edit();
                }}
              />
              <small className="un-book-note">
                음성 제작을 지원하는 TTS 모델을 입력해요. 인물을 판단하는 언어 모델과는 달라요.
              </small>
            </label>
          </>
        ) : (
          <label className="un-cast-field">
            <span>목소리</span>
            <select
              value={voiceId}
              disabled={!!value}
              onChange={(e) => {
                setVoiceId(e.target.value);
                const previous = voices.find((v) => v.id === voiceId);
                const next = voices.find((v) => v.id === e.target.value);
                if (!alias || alias === previous?.label) setAlias(next?.label ?? '');
                if (!description || description === previous?.description) setDescription(next?.description ?? '');
              }}
            >
              {value && !voices.some((v) => v.id === voiceId) && (
                <option value={voiceId}>{value.providerVoiceId} · 목록에 없음</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.providerName ?? v.providerId}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="un-cast-field">
          <span>별칭</span>
          <input
            value={alias}
            maxLength={80}
            placeholder="예: 차분한 중저음"
            onChange={(e) => {
              setAlias(e.target.value);
              edit();
            }}
          />
        </label>
        {!design && (
          <label className="un-cast-field">
            <span>음색</span>
            <input
              value={timbre}
              maxLength={200}
              placeholder="예: 낮고 부드러운, 또렷한"
              onChange={(e) => setTimbre(e.target.value)}
            />
          </label>
        )}
        <label className="un-cast-field">
          <span>{design ? '만들 목소리 설명' : '설명'}</span>
          <textarea
            rows={4}
            value={description}
            maxLength={2000}
            placeholder="예: 따뜻하고 낮은 음색. 서두르지 않고 명료하게 말하는 성인 목소리."
            onChange={(e) => {
              setDescription(e.target.value);
              edit();
            }}
          />
        </label>
        <label className="un-cast-field">
          <span>언어</span>
          <input
            value={language}
            maxLength={40}
            placeholder="ko"
            onChange={(e) => {
              setLanguage(e.target.value);
              edit();
            }}
          />
        </label>
        {design && designer?.paid && (
          <label className="un-book-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>새 목소리를 만드는 API 사용 요금을 확인했어요.</span>
          </label>
        )}
      </fieldset>
      {design && (
        <p className="un-book-note">
          만든 목소리는 보관함에 저장해서 계속 사용해요. 응답이 늦어져도 같은 요청을 중복으로 보내지 않아요.
        </p>
      )}
      <div className="un-book-actions">
        <button
          type="button"
          className="un-btn is-primary is-sm"
          disabled={busy || !valid}
          onClick={() =>
            design
              ? onDesign({ requestId, providerId, modelId, alias, prompt: description, language, confirmPaid: ack })
              : onSave({ voiceId, alias, timbre, description, language, enabled: value?.enabled ?? true })
          }
        >
          {busy ? '처리하는 중…' : design ? '만들어 보관하기' : '저장'}
        </button>
        <button type="button" className="un-btn is-text is-sm" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
