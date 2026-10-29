import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Play, Plus, RefreshCw, Square, Trash2, WandSparkles } from 'lucide-react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type {
  LibraryVoice,
  VoiceLibraryInput,
  VoiceLibraryPort,
  VoiceDesignProvider,
} from '../../providers/voice-library';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import { isGeminiVoiceDesignModel } from '../../providers/voice-library';
import { voiceDesigners } from './UiNextCastingOptions';
import { createVoicePreview, useVoicePreview } from './voice-preview';
import { cx, Switch } from '../components/primitives';
import './audiobook.css';
import './listen.css';
import './tts-connections.css';
import './speaker-generation.css';
import './voice-library.css';

type Editing = { kind: 'edit'; row: LibraryVoice } | { kind: 'add'; voiceId?: string } | { kind: 'design' };
type View = 'all' | 'unlabeled' | 'off';
/**
 * Quick picks only edit the timbre text; they are selection hints, never synthesis settings.
 * Gender and age describe how the voice sounds to the person labelling it; nothing is inferred or preset.
 */
const TIMBRE_WORDS = [
  ['성별 느낌', ['남성적인', '여성적인', '중성적인']],
  ['나이 느낌', ['어린', '젊은', '중년의', '나이 든']],
  ['음높이', ['낮은', '중간 높이', '높은']],
  ['질감', ['맑은', '부드러운', '허스키한', '거친', '숨소리 섞인']],
  ['인상', ['따뜻한', '차분한', '밝은', '냉정한', '위엄 있는', '장난스러운']],
  ['말투', ['느긋한', '또렷한', '빠른']],
] as const;
const timbreWords = (value: string) =>
  value
    .split(/[,，、]/)
    .map((word) => word.trim())
    .filter(Boolean);
const toggleWord = (value: string, word: string) => {
  const words = timbreWords(value);
  return (words.includes(word) ? words.filter((w) => w !== word) : [...words, word]).join(', ');
};
const unlabeled = (row: LibraryVoice) => !row.timbre.trim() && !row.description.trim();
const longText = (value: string) => value.length > 140 || value.split('\n').length > 3;
const has = (query: string, ...parts: (string | undefined)[]) => parts.join(' ').toLowerCase().includes(query);

export default function UiNextVoiceLibrary({
  port,
  voices,
  onChanged,
  beforePreview,
  previewVoice,
  previewRevision,
}: {
  port: VoiceLibraryPort;
  voices: readonly PlainTTSVoice[];
  onChanged(): void;
  beforePreview?(): void | Promise<void>;
  /** Fixed-sentence sample of a catalog voice that is not saved yet; nothing is written to the library. */
  previewVoice?(voiceId: string, signal: AbortSignal): Promise<Blob>;
  /** Catalog revision: part of the sample key, so a changed connection is heard anew. */
  previewRevision?: string;
}) {
  const [rows, setRows] = useState<LibraryVoice[]>();
  const [designers, setDesigners] = useState<VoiceDesignProvider[]>([]);
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string>();
  const [remove, setRemove] = useState<string>();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [unlistedOpen, setUnlistedOpen] = useState(false);
  const lifetime = useRef(new AbortController());
  const loadVersion = useRef(0);
  const sampleRun = useRef<AbortController>();
  const working = useRef(false);
  const [audio] = useState(() => new BrowserAudioSession());
  // Saved voices keep their own stored sample (port.sample); catalog voices use the plain sample path.
  const sampleLatest = useRef({ previewVoice, beforePreview });
  sampleLatest.current = { previewVoice, beforePreview };
  const stopSaved = useCallback(() => {
    sampleRun.current?.abort();
    audio.stop();
    setPlaying(undefined);
  }, [audio]);
  const [catalogPreview] = useState(() =>
    createVoicePreview(
      (voiceId, signal) => {
        const load = sampleLatest.current.previewVoice;
        if (!load) throw new Error('미리듣기를 쓸 수 없어요.');
        return load(voiceId, signal);
      },
      async () => {
        stopSaved();
        await sampleLatest.current.beforePreview?.();
      },
    ),
  );
  const catalogSample = useVoicePreview(catalogPreview);
  useEffect(() => () => catalogPreview.dispose(), [catalogPreview]);
  useEffect(() => catalogPreview.reset(), [catalogPreview, port, previewRevision]);
  // Opening, switching or closing an editor stops any sample, saved or catalog, so none keeps playing unseen.
  useEffect(() => {
    catalogPreview.stop();
    stopSaved();
  }, [catalogPreview, stopSaved, editing]);
  const listen = (token: string, voiceId: string) => {
    const voice = voices.find((v) => v.id === voiceId);
    if (!previewVoice || !voice) return undefined;
    const phase = catalogSample.token === token ? catalogSample.phase : undefined;
    return {
      phase,
      play: () =>
        void catalogPreview.play(token, JSON.stringify([previewRevision, voiceId, voice.model?.revision]), voiceId),
    };
  };
  const load = async () => {
    const signal = lifetime.current.signal;
    const version = ++loadVersion.current;
    try {
      const data = await port.list(signal);
      if (signal.aborted || version !== loadVersion.current) return;
      setRows(data.voices);
      setDesigners(voiceDesigners(data.designers));
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
    catalogPreview.stop();
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
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const saved = new Set(rows?.map((row) => row.voiceId));
  const q = query.trim().toLowerCase();
  const counts = {
    all: rows?.length ?? 0,
    unlabeled: rows?.filter(unlabeled).length ?? 0,
    off: rows?.filter((row) => !row.enabled).length ?? 0,
  };
  const shown = rows?.filter(
    (r) =>
      (view === 'all' || (view === 'unlabeled' ? unlabeled(r) : !r.enabled)) &&
      has(q, r.alias, r.timbre, r.description, r.language, r.providerId, r.providerVoiceId, r.voiceId),
  );
  const unlisted = rows ? voices.filter((v) => !saved.has(v.id)) : [];
  const shownUnlisted = unlisted.filter((v) => has(q, v.label, v.description, v.id, v.providerName, v.lang));
  return (
    <section className="un-voice-library un-cast" aria-label="목소리 보관함">
      <p className="un-book-note">
        여기 저장한 목소리는 모든 작품에서 쓸 수 있어요. 설명을 고쳐도 이미 만든 음성은 바뀌지 않아요.
      </p>
      {(error || catalogSample.error) && (
        <p role="alert" className="un-book-error">
          {error ?? catalogSample.error?.message}
        </p>
      )}
      {editing ? (
        <VoiceEditor
          key={
            editing.kind === 'edit'
              ? editing.row.id
              : `${editing.kind}:${(editing.kind === 'add' && editing.voiceId) || ''}`
          }
          value={editing.kind === 'edit' ? editing.row : undefined}
          preset={editing.kind === 'add' ? editing.voiceId : undefined}
          design={editing.kind === 'design'}
          voices={voices}
          saved={saved}
          designers={designers}
          busy={busy}
          playing={editing.kind === 'edit' && playing === editing.row.id}
          onPreview={editing.kind === 'edit' ? () => void preview(editing.row) : undefined}
          listen={(voiceId) => listen(`editor:${voiceId}`, voiceId)}
          onVoiceChange={() => catalogPreview.stop()}
          onCancel={() => setEditing(undefined)}
          onSave={(input) =>
            void act(
              () => port.save(input, lifetime.current.signal, editing.kind === 'edit' ? editing.row.id : undefined),
              true,
            )
          }
          onDesign={(input) => void act(() => port.design(input, lifetime.current.signal), true)}
        />
      ) : (
        <>
          <div className="un-book-actions">
            <button type="button" className="un-btn is-ghost is-sm" onClick={() => setEditing({ kind: 'add' })}>
              <Plus size={16} />
              기존 목소리 추가
            </button>
            {designers.length > 0 && (
              <button type="button" className="un-btn is-ghost is-sm" onClick={() => setEditing({ kind: 'design' })}>
                <WandSparkles size={16} />
                Gemini Flash로 만들기
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
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="별칭, 음색, 설명, 언어, ID" />
          </label>
          {!rows ? (
            <p className="un-book-note">불러오는 중…</p>
          ) : rows.length === 0 ? (
            <p className="un-book-note is-box">
              아직 저장한 목소리가 없어요. 자주 쓸 목소리에 설명을 달아 두면 AI가 인물에 맞게 골라요.
            </p>
          ) : (
            <>
              <div className="un-chip-row" role="group" aria-label="보관함 보기">
                {(
                  [
                    ['all', '전체'],
                    ['unlabeled', '라벨 필요'],
                    ['off', '자동 배정 꺼짐'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={cx('un-chip', view === key && 'is-active')}
                    aria-pressed={view === key}
                    onClick={() => setView(key)}
                  >
                    {label} <small>{counts[key]}</small>
                  </button>
                ))}
              </div>
              {shown!.length === 0 ? (
                <p className="un-book-note is-box">조건에 맞는 목소리가 없어요.</p>
              ) : (
                <ul className="un-book-list">
                  {shown!.map((row) => (
                    <li key={row.id} className="un-book-item">
                      <div className="un-book-item-head">
                        <b>{row.alias}</b>
                        <Switch
                          label={`${row.alias} 자동 배정에 사용`}
                          checked={row.enabled}
                          disabled={busy}
                          onChange={() =>
                            void act(() =>
                              port.save({ ...row, enabled: !row.enabled }, lifetime.current.signal, row.id),
                            )
                          }
                        />
                      </div>
                      {(unlabeled(row) || row.origin === 'designed' || !row.available) && (
                        <div className="un-voice-badges">
                          {unlabeled(row) && <span className="un-book-badge">라벨 필요</span>}
                          {row.origin === 'designed' && <span className="un-book-badge">만든 목소리</span>}
                          {!row.available && <span className="un-book-badge is-failed">연결 확인 필요</span>}
                        </div>
                      )}
                      <small className="un-book-meta">
                        {row.timbre || '음색 없음'} · {row.language || '언어 미지정'}
                        {row.enabled ? '' : ' · 자동 배정 꺼짐'}
                      </small>
                      {row.description && (
                        <>
                          <p className={cx('un-book-note un-voice-desc', expanded.has(row.id) && 'is-open')}>
                            {row.description}
                          </p>
                          {longText(row.description) && (
                            <button
                              type="button"
                              className="un-btn is-text is-sm un-voice-more"
                              aria-expanded={expanded.has(row.id)}
                              onClick={() => toggleExpanded(row.id)}
                            >
                              {expanded.has(row.id) ? '접기' : '더 보기'}
                            </button>
                          )}
                        </>
                      )}
                      <small className="un-voice-id">{voiceIdLine(row)}</small>
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
                          onClick={() => setEditing({ kind: 'edit', row })}
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
            </>
          )}
          {unlisted.length > 0 && (
            <details
              className="un-cast-options"
              open={unlistedOpen}
              onToggle={(e) => setUnlistedOpen(e.currentTarget.open)}
            >
              <summary>보관함에 없는 목록 목소리 {unlisted.length}개</summary>
              {shownUnlisted.length === 0 ? (
                <p className="un-book-note">조건에 맞는 목소리가 없어요.</p>
              ) : (
                <ul className="un-book-list">
                  {shownUnlisted.map((voice) => (
                    <li key={voice.id} className="un-book-item">
                      <div className="un-book-item-head">
                        <b>{voice.label}</b>
                      </div>
                      <div className="un-book-actions">
                        <SampleButton name={voice.label} sample={listen(`list:${voice.id}`, voice.id)} />
                        <button
                          type="button"
                          className="un-btn is-text is-sm"
                          disabled={busy}
                          aria-label={`${voice.label} 라벨 달기`}
                          onClick={() => setEditing({ kind: 'add', voiceId: voice.id })}
                        >
                          <Plus size={15} />
                          라벨 달기
                        </button>
                      </div>
                      {voice.description && <p className="un-book-note un-voice-desc">{voice.description}</p>}
                      <small className="un-voice-id">{catalogIdLine(voice)}</small>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          <p className="un-book-note">미리듣기 샘플이 없으면 새로 만들어요. 유료 API 요금이 나올 수 있어요.</p>
        </>
      )}
    </section>
  );
}
type Sample = { phase?: 'loading' | 'playing'; play(): void };
/** Plays on press only; the same press stops it or cancels a sample still loading. */
function SampleButton({ name, sample }: { name: string; sample?: Sample }) {
  if (!sample) return null;
  return (
    <button
      type="button"
      className="un-btn is-ghost is-sm"
      aria-label={`${name} 미리듣기`}
      aria-pressed={!!sample.phase}
      aria-busy={sample.phase === 'loading' || undefined}
      onClick={sample.play}
    >
      {sample.phase ? <Square size={15} /> : <Play size={15} />}
      {sample.phase === 'loading' ? '불러오는 중' : sample.phase === 'playing' ? '정지' : '미리듣기'}
    </button>
  );
}
const voiceIdLine = (row: LibraryVoice) =>
  [row.providerId, row.providerVoiceId, row.model.modelId].filter(Boolean).join(' · ');
const catalogIdLine = (voice: PlainTTSVoice) =>
  [voice.providerName ?? voice.providerId, voice.id, voice.modelId].filter(Boolean).join(' · ');
function VoiceEditor({
  value,
  preset,
  design,
  voices,
  saved,
  designers,
  busy,
  playing,
  onPreview,
  listen,
  onVoiceChange,
  onCancel,
  onSave,
  onDesign,
}: {
  value?: LibraryVoice;
  /** Catalog voice picked from the unlisted list. */
  preset?: string;
  design: boolean;
  voices: readonly PlainTTSVoice[];
  /** Catalog IDs already in the library: adding one again would replace its saved labels. */
  saved: ReadonlySet<string>;
  designers: VoiceDesignProvider[];
  busy: boolean;
  playing: boolean;
  onPreview?(): void;
  /** Catalog sample of an unsaved voice; undefined where samples cannot be made. */
  listen?(voiceId: string): Sample | undefined;
  onVoiceChange?(): void;
  onCancel(): void;
  onSave(v: VoiceLibraryInput): void;
  onDesign(v: Parameters<VoiceLibraryPort['design']>[0]): void;
}) {
  const initial = value ? undefined : (voices.find((v) => v.id === preset) ?? voices.find((v) => !saved.has(v.id)));
  const [voiceId, setVoiceId] = useState(value?.voiceId ?? initial?.id ?? '');
  const [alias, setAlias] = useState(value?.alias ?? (design ? '' : (initial?.label ?? '')));
  const [timbre, setTimbre] = useState(value?.timbre ?? '');
  const [description, setDescription] = useState(value?.description ?? (design ? '' : (initial?.description ?? '')));
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
  const duplicate = !value && saved.has(voiceId);
  const valid =
    alias.trim() &&
    (design ? designer && modelId && description.trim() && (!designer.paid || ack) : voiceId && !duplicate);
  const catalogVoice = voices.find((v) => v.id === voiceId);
  const chosen = timbreWords(timbre);
  return (
    <div className="un-filter un-tts-conn-editor un-speaker-engine-form">
      <h3>{design ? '새 목소리 만들기' : value ? '목소리 수정' : '목소리 추가'}</h3>
      {!design && (value || catalogVoice) && (
        <div className="un-voice-editor-id">
          <small className="un-voice-id">
            {value ? voiceIdLine(value) : catalogIdLine(catalogVoice!)}
            {value?.origin === 'designed' ? ' · 만든 목소리' : ''}
          </small>
          {value && onPreview && (
            <button
              type="button"
              className="un-btn is-ghost is-sm"
              disabled={!value.available && !value.sampleAvailable}
              onClick={onPreview}
            >
              {playing ? <Square size={15} /> : <Play size={15} />}미리듣기
            </button>
          )}
          {!value && catalogVoice && <SampleButton name={catalogVoice.label} sample={listen?.(catalogVoice.id)} />}
        </div>
      )}
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
            <small className="un-book-note">
              <b>{modelId || '확인 필요'}</b> · 적은 설명대로 목소리를 만들어 저장해요.
            </small>
          </>
        ) : (
          <label className="un-cast-field">
            <span>목소리</span>
            <select
              value={voiceId}
              disabled={!!value}
              onChange={(e) => {
                onVoiceChange?.();
                setVoiceId(e.target.value);
                const previous = voices.find((v) => v.id === voiceId);
                const next = voices.find((v) => v.id === e.target.value);
                if (!alias || alias === previous?.label) setAlias(next?.label ?? '');
                if (!description || description === previous?.description) setDescription(next?.description ?? '');
              }}
            >
              {!voiceId && <option value="">추가할 목소리 없음</option>}
              {value && !voices.some((v) => v.id === voiceId) && (
                <option value={voiceId}>{value.providerVoiceId} · 목록에 없음</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id} disabled={!value && saved.has(v.id)}>
                  {v.label} · {v.providerName ?? v.providerId}
                  {!value && saved.has(v.id) ? ' · 보관함에 있음' : ''}
                </option>
              ))}
            </select>
            {!value && saved.size > 0 && (
              <small className="un-book-note">
                {duplicate || !voiceId
                  ? '이미 보관함에 있는 목소리예요. 목록의 ‘수정’에서 바꿔 주세요.'
                  : '보관함에 있는 목소리는 목록의 ‘수정’에서 바꿔요.'}
              </small>
            )}
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
          <div className="un-voice-timbre">
            <label className="un-cast-field">
              <span>음색</span>
              <input
                value={timbre}
                maxLength={200}
                placeholder="예: 낮은, 부드러운, 또렷한"
                onChange={(e) => setTimbre(e.target.value)}
              />
            </label>
            <div className="un-voice-chips" role="group" aria-label="음색 빠르게 고르기">
              {TIMBRE_WORDS.map(([group, words]) => (
                <div key={group} className="un-chip-row" role="group" aria-label={group}>
                  <small>{group}</small>
                  {words.map((word) => {
                    const on = chosen.includes(word);
                    return (
                      <button
                        key={word}
                        type="button"
                        className={cx('un-chip', on && 'is-active')}
                        aria-pressed={on}
                        disabled={!on && toggleWord(timbre, word).length > 200}
                        onClick={() => setTimbre(toggleWord(timbre, word))}
                      >
                        {word}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
        <label className="un-cast-field">
          <span>{design ? '만들 목소리 설명' : '설명'}</span>
          <textarea
            rows={design ? 4 : 5}
            value={description}
            maxLength={2000}
            placeholder={
              design
                ? '예: 30대 여성, 낮고 따뜻한 중저음, 표준어 억양, 또박또박 천천히 말함.'
                : '예: 서두르지 않고 명료하게 말해요.\n어울리는 인물: 노련한 기사, 침착한 해설자\n어울리지 않는 인물: 어린아이'
            }
            onChange={(e) => {
              setDescription(e.target.value);
              edit();
            }}
          />
          <small className="un-book-note">
            {description.length}/2000
            {!design && ' · 들은 느낌과 어울리는 인물을 적어 두면 더 잘 골라요.'}
          </small>
          {design && isGeminiVoiceDesignModel(modelId) && (
            <small className="un-book-note">
              성별·나이·음색·말투처럼 늘 같은 특징을 적어 주세요. 장면별 감정은 ‘목소리 바꾸기’의 장면 연기에서 정해요.
            </small>
          )}
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
            <span>유료 API 요금이 나올 수 있어요. 확인했어요.</span>
          </label>
        )}
      </fieldset>
      <p className="un-book-note">
        {design
          ? '응답이 늦어도 같은 목소리가 두 번 만들어지지 않아요.'
          : '설명은 AI가 새 인물에게 목소리를 고를 때 참고해요. 이미 배정된 인물은 바뀌지 않아요.'}
      </p>
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
