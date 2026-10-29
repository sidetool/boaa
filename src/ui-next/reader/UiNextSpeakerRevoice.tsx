import { AlertCircle, ArrowRight, LoaderCircle, Mic2, Play, Square, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import type {
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerRevoiceEstimate,
  SpeakerRevoiceInput,
  SpeakerRevoiceSource,
} from '../../providers/speaker-generation';
import type { LibraryVoice, VoiceDesignProvider } from '../../providers/voice-library';
import { formatCount } from '../../utils/format';
import { cx } from '../components/primitives';
import { BatchAudioToggle, batchable, flashDesigner, SelectionModelField } from './UiNextCastingOptions';
import { useVoicePreview, type VoicePreview } from './voice-preview';

type Speaker = SpeakerRevoiceSource['voices'][number];
/** keep: the captured voice. swap: another listed voice. design: a new Gemini 3.8 Flash TTS voice. */
type Plan = 'keep' | 'swap' | 'design';
type Row = { plan: Plan; voiceId: string };
type ActingMode = NonNullable<SpeakerRevoiceInput['acting']>['mode'];
const NARRATOR = 'narrator';
/** The server creates at most this many voices per job; the explicit list is the whole budget. */
const MAX_DESIGN = 8;
/** Short delivery cues; they never change who the voice sounds like. */
const ACTING_EXAMPLES = ['조용히 속삭이듯', '지친 듯', '긴장해서 빠르게', '단호하고 차갑게', '밝고 들뜬', '울먹이며'];
const IMPORTANCE = { major: '주요', supporting: '조연', extra: '엑스트라' } as const;
const RANK = { major: 0, supporting: 1, extra: 2 } as const;
const STOPPED: readonly SpeakerGenerationJob['status'][] = ['paused', 'failed', 'completed'];
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;

/**
 * 목소리 바꾸기: a new audio-only job from this job's captured plan. Each character is kept, given
 * another listed voice, or (Gemini 3.8 Flash TTS narrator only) given a newly designed voice.
 * The source job, its audio and its speaker analysis never change; the book's assignments follow
 * only when applyToBook is on, and only for characters changed here.
 */
export default function UiNextSpeakerRevoice({
  job,
  port,
  voices,
  library,
  engines,
  designers,
  preview,
  previewRevision,
  onCreated,
}: {
  job: SpeakerGenerationJob;
  port: SpeakerGenerationPort;
  voices: readonly PlainTTSVoice[];
  /** All model connections: analysis ones add acting tags, selection ones plan new voices. */
  engines?: readonly SpeakerEngine[];
  /** Voice design connections; only the narrator's own Gemini 3.8 Flash TTS connection is used. */
  designers?: readonly VoiceDesignProvider[];
  /** Labels only; descriptions are never sent as acting directions. */
  library?: readonly LibraryVoice[];
  /** Page-wide sample player; absent where samples cannot be made (no server catalog). */
  preview?: VoicePreview;
  /** Catalog revision: part of the sample cache key, so a changed connection is heard anew. */
  previewRevision?: string;
  /** Reloads the parent job list; it must not start playback. */
  onCreated(): void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SpeakerRevoiceSource>();
  const [sourceError, setSourceError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [directions, setDirections] = useState<Record<string, string>>({});
  const [actingChoice, setActingChoice] = useState<ActingMode>();
  const [actingEngineChoice, setActingEngineChoice] = useState<string>();
  const [selectionChoice, setSelectionChoice] = useState<string>();
  const [applyToBook, setApplyToBook] = useState(true);
  // A fresh choice for the new audio: off unless turned on here, whatever the source did.
  const [batchChoice, setBatchChoice] = useState(false);
  const [estimate, setEstimate] = useState<{ key: string; value: SpeakerRevoiceEstimate }>();
  const [ack, setAck] = useState(false);
  const [working, setWorking] = useState<'estimate' | 'create'>();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState(false);
  const creating = useRef(false);
  const run = useRef<AbortController>();
  useEffect(() => () => run.current?.abort(), []);
  const stopped = STOPPED.includes(job.status);
  // Closing or a resumed source cancels a pending estimate/create; late replies then change nothing here.
  useEffect(() => {
    if (open && stopped) return;
    const pending = run.current;
    run.current = undefined;
    pending?.abort();
    setWorking(undefined);
    // A resumed source may plan more audio, so its estimate and consent no longer apply.
    if (!stopped) {
      setEstimate(undefined);
      setAck(false);
    }
  }, [open, stopped]);
  const available = !!(port.revoiceSource && port.estimateRevoice && port.revoice) && job.itemCount > 0;
  const previewState = useVoicePreview(preview);
  const mine = `${job.id}:`;
  // Closing, a resumed source or leaving the page stops this card's sample; other cards keep theirs.
  useEffect(() => {
    if (!open || !stopped) preview?.stop((token) => token.startsWith(mine));
  }, [open, stopped, preview, mine]);
  useEffect(() => () => preview?.stop((token) => token.startsWith(mine)), [preview, mine]);

  useEffect(() => {
    if (!open || !available || !stopped || !port.revoiceSource) return;
    const c = new AbortController();
    setSourceError(undefined);
    port.revoiceSource(job.id, c.signal).then(
      (next) => {
        if (c.signal.aborted) return;
        setSource(next);
        // A reload adds newly planned speakers; choices already made here stay as they are.
        setDirections((current) => {
          const merged = { ...current };
          for (const v of next.voices) merged[v.speakerId] ??= v.instructions ?? '';
          return merged;
        });
      },
      (e) => {
        if (!c.signal.aborted) setSourceError(message(e, '이 음성의 인물 목록을 불러오지 못했어요.'));
      },
    );
    return () => c.abort();
  }, [open, available, port, job.id, job.itemCount, stopped, attempt]);

  const catalog = (id?: string) => voices.find((v) => v.id === id);
  const label = (id: string) =>
    library?.find((item) => item.voiceId === id)?.alias || catalog(id)?.label || '목록에 없는 목소리';
  const analysisEngines = engines?.filter((e) => e.purpose !== 'casting');
  const selectionEngines = engines?.filter((e) => e.purpose === 'casting') ?? [];
  const speakers = source?.voices ?? [];
  const rowOf = (v: Speaker): Row => rows[v.speakerId] ?? { plan: 'keep', voiceId: v.voiceId };
  const voiceOf = (v: Speaker) => {
    const r = rowOf(v);
    return r.plan === 'swap' ? r.voiceId : v.voiceId;
  };
  // The narrator decides whether this is a Flash job; with no narrator lines the original narrator does.
  const narratorRow = speakers.find((v) => v.speakerId === NARRATOR);
  const narratorVoice = catalog(narratorRow ? voiceOf(narratorRow) : source?.narratorVoiceId);
  const designer = flashDesigner(narratorVoice, designers);
  const selectionId = selectionChoice ?? selectionEngines.find((e) => e.enabled)?.id;
  const selection = selectionEngines.find((e) => e.id === selectionId);
  const canDesign = !!designer && selectionEngines.length > 0;
  // A plan only counts while it still differs from the captured voice; without Flash, 'design' is void.
  const effective = (v: Speaker): Plan => {
    const r = rowOf(v);
    if (r.plan === 'design') return designer && v.speakerId !== NARRATOR ? 'design' : 'keep';
    return r.plan === 'swap' && r.voiceId !== v.voiceId ? 'swap' : 'keep';
  };
  const designIds = speakers.filter((v) => effective(v) === 'design').map((v) => v.speakerId);
  const changedSpeakers = speakers.filter((v) => effective(v) !== 'keep');
  const kept = speakers.length - changedSpeakers.length;
  const characterChanged = changedSpeakers.some((v) => v.speakerId !== NARRATOR);
  const narratorChanged = changedSpeakers.some((v) => v.speakerId === NARRATOR);
  const full = designIds.length >= MAX_DESIGN;
  // A design target will speak through a new voice on the narrator's Flash connection, not its old voice,
  // which may even be gone; acting and direction support follow that connection.
  const capability = (v: Speaker) => (effective(v) === 'design' ? narratorVoice : catalog(voiceOf(v)));
  const batchAvailable = speakers.some((v) => batchable(capability(v)));
  const batchAudio = batchAvailable && batchChoice;
  // Turning batching off for a batched source re-makes it span by span, which is a change on its own.
  const batchChanged = batchAudio !== !!source?.batched;

  // Spans without tags; older sources omit it, so untagged means needed.
  const needsActing = source ? (source.needsActing ?? !source.hasActing) : false;
  const showActing = !!source?.hasActing || voices.some((v) => v.autoActingSupported === true);
  const hinted = analysisEngines?.some((e) => e.id === source?.actingEngineId) ? source?.actingEngineId : undefined;
  const actingEngineId = actingEngineChoice ?? hinted;
  const actingEngine = analysisEngines?.find((e) => e.id === actingEngineId);
  const capturedSupported = speakers.length > 0 && speakers.every((v) => catalog(v.voiceId)?.autoActingSupported);
  // Fill missing tags by default only when it can start as is: capable voices and the original analysis model.
  const defaultMode: ActingMode =
    showActing && needsActing && capturedSupported && analysisEngines?.find((e) => e.id === hinted)?.enabled
      ? 'auto'
      : 'preserve';
  const actingMode = actingChoice ?? defaultMode;

  const input: SpeakerRevoiceInput | undefined = source && {
    ...(actingMode === 'preserve'
      ? {}
      : {
          acting: {
            mode: actingMode,
            ...(actingMode === 'auto' && actingEngineId ? { engineId: actingEngineId } : {}),
          },
        }),
    // The server sizes the job from designSpeakerIds; the casting block keeps its older required fields.
    ...(designIds.length && designer
      ? {
          designSpeakerIds: designIds,
          casting: {
            engineId: selectionId,
            autoDesign: true,
            designMode: 'characters' as const,
            designProviderId: designer.id,
            designModelId: designer.modelId,
            maxDesignedVoices: designIds.length,
          },
        }
      : {}),
    ...(characterChanged ? { applyToBook } : {}),
    ...(batchAudio ? { batchAudio: true } : {}),
    // Design targets keep their captured voiceId as a placeholder; the server replaces it.
    voices: speakers.map((v) => {
      const text = (directions[v.speakerId] ?? v.instructions ?? '').trim();
      return {
        speakerId: v.speakerId,
        voiceId: voiceOf(v),
        ...(capability(v)?.instructionsSupported === true && text ? { instructions: text } : {}),
      };
    }),
  };
  const directed = speakers.filter((v, i) => (v.instructions ?? '') !== (input?.voices[i]?.instructions ?? ''));
  const missing = speakers.filter((v) => effective(v) !== 'design' && !catalog(voiceOf(v)));
  // Automatic acting tags are applied only through voices the server marks as capable.
  const acted = actingMode === 'auto' || (actingMode === 'preserve' && !!source?.hasActing);
  const actingUnsupported = acted ? speakers.filter((v) => capability(v)?.autoActingSupported !== true) : [];
  const problem = !stopped
    ? '만들기를 멈추거나 끝난 뒤 바꿀 수 있어요.'
    : missing.length
      ? `${missing.map((v) => v.name).join(', ')}의 목소리를 찾을 수 없어요. 다른 목소리로 바꿔 주세요.`
      : actingUnsupported.length
        ? `장면 연기를 지원하지 않는 목소리예요: ${actingUnsupported.map((v) => v.name).join(', ')}. 목소리를 바꾸거나 장면 연기를 빼 주세요.`
        : actingMode === 'auto' && needsActing && !actingEngine?.enabled
          ? '연기를 분석할 모델을 골라 주세요.'
          : designIds.length && !selection?.enabled
            ? '새 목소리를 정할 배정 AI 모델을 골라 주세요.'
            : changedSpeakers.length === 0 && directed.length === 0 && actingMode === 'preserve' && !batchChanged
              ? '바꿀 인물을 골라 주세요.'
              : undefined;
  const inputKey = input ? JSON.stringify(input) : '';
  const fresh = estimate?.key === inputKey ? estimate.value : undefined;
  useEffect(() => {
    setAck(false);
    setError(undefined);
  }, [inputKey]);
  const stopRow = (speakerId: string) => preview?.stop((token) => token.startsWith(`${mine}${speakerId}:`));
  const setRow = (v: Speaker, next: Partial<Row>) => {
    setCreated(false);
    stopRow(v.speakerId);
    setRows((current) => ({ ...current, [v.speakerId]: { ...rowOf(v), ...next } }));
  };
  const choosePlan = (v: Speaker, plan: Plan) => {
    const r = rowOf(v);
    // Switching to 'another voice' starts on a different voice so the change is visible at once.
    const first = voices.find((item) => item.id !== v.voiceId)?.id ?? v.voiceId;
    setRow(v, { plan, voiceId: plan === 'swap' && r.voiceId === v.voiceId ? first : r.voiceId });
  };
  // One tap for the common case: main cast first, by how much they speak, up to the job limit.
  const bulkTargets = [...speakers]
    .filter((v) => v.speakerId !== NARRATOR && (!v.importance || v.importance !== 'extra'))
    .sort((a, b) => b.itemCount - a.itemCount)
    .slice(0, MAX_DESIGN);
  const bulkLabel = speakers.some((v) => v.importance) ? '주요·조연 새로 만들기' : '인물 모두 새로 만들기';
  const designAll = () => {
    setCreated(false);
    preview?.stop((token) => token.startsWith(mine));
    setRows((current) => {
      const next = { ...current };
      for (const v of bulkTargets) next[v.speakerId] = { ...rowOf(v), plan: 'design' };
      return next;
    });
  };
  const reset = () => {
    setCreated(false);
    preview?.stop((token) => token.startsWith(mine));
    setRows({});
  };
  // Samples exist only for listed voices; a character still waiting for its new voice has nothing to play.
  const listen = (v: Speaker) =>
    preview
      ? (voiceId: string, which: 'now' | 'pick') => {
          const voice = catalog(voiceId);
          if (!voice) return null;
          const token = `${mine}${v.speakerId}:${which}:${voiceId}`;
          const key = JSON.stringify([previewRevision, voiceId, voice.model?.revision]);
          return (
            <PreviewButton
              name={label(voiceId)}
              phase={previewState.token === token ? previewState.phase : undefined}
              onClick={() => void preview.play(token, key, voiceId)}
            />
          );
        }
      : undefined;
  const previewError = (v: Speaker) =>
    previewState.error?.token.startsWith(`${mine}${v.speakerId}:`) ? previewState.error.message : undefined;
  const paidSample =
    !!preview &&
    speakers.some((v) => catalog(v.voiceId)?.paid || (rowOf(v).plan === 'swap' && catalog(rowOf(v).voiceId)?.paid));

  const runEstimate = async () => {
    if (!input || problem || creating.current || !port.estimateRevoice) return;
    run.current?.abort();
    const c = new AbortController();
    run.current = c;
    setWorking('estimate');
    setError(undefined);
    try {
      const value = await port.estimateRevoice(job.id, input, c.signal);
      if (!c.signal.aborted) setEstimate({ key: inputKey, value });
    } catch (e) {
      if (!c.signal.aborted) setError(message(e, '확인하지 못했어요. 다시 시도해 주세요.'));
    } finally {
      if (run.current === c) setWorking(undefined);
    }
  };
  const runCreate = async () => {
    if (!input || !fresh || (fresh.paid && !ack) || creating.current || !port.revoice) return;
    creating.current = true;
    run.current?.abort();
    const c = new AbortController();
    run.current = c;
    setWorking('create');
    setError(undefined);
    try {
      await port.revoice(job.id, input, fresh.fingerprint, fresh.paid && ack, c.signal);
      if (c.signal.aborted) return onCreated();
      setEstimate(undefined);
      setCreated(true);
      onCreated();
    } catch (e) {
      // A cancelled create may still have reached the server: reload the list, never resend.
      if (c.signal.aborted) return onCreated();
      setError(
        `${message(e, '시작하지 못했어요.')} 목록을 새로 불러왔어요. 다시 눌러도 같은 작업이 두 번 생기지 않아요.`,
      );
      onCreated();
    } finally {
      creating.current = false;
      if (run.current === c) setWorking(undefined);
    }
  };

  // Hidden while the source job is running; the open state and draft survive until it stops again.
  if (!available || !stopped) return null;
  if (!open)
    return (
      <button type="button" className="un-recast-open" onClick={() => setOpen(true)}>
        <Mic2 size={17} aria-hidden="true" />
        <span>
          <b>목소리 바꾸기</b>
          <small>인물별로 다른 목소리로 다시 만들어요</small>
        </span>
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    );
  const sorted = [...speakers].sort(
    (a, b) =>
      Number(b.speakerId === NARRATOR) - Number(a.speakerId === NARRATOR) ||
      (a.importance ? RANK[a.importance] : 3) - (b.importance ? RANK[b.importance] : 3) ||
      b.itemCount - a.itemCount,
  );
  const partial = source && (job.planningComplete === false || source.chapterCount < job.chapterCount);
  const instructable = speakers.filter((v) => capability(v)?.instructionsSupported === true);
  // Written directions are kept for later but not sent through a voice that cannot take them.
  const dropped = speakers.filter(
    (v) => capability(v)?.instructionsSupported !== true && (directions[v.speakerId] ?? v.instructions ?? '').trim(),
  );
  return (
    <section className="un-recast" aria-label="목소리 바꾸기">
      <div className="un-recast-top">
        <h4>목소리 바꾸기</h4>
        <button
          type="button"
          className="un-icon-btn is-sm"
          aria-label="목소리 바꾸기 닫기"
          onClick={() => setOpen(false)}
        >
          <X size={16} />
        </button>
      </div>
      <p className="un-book-note">바꿀 인물만 고르세요. 새 음성으로 따로 만들고, 지금 음성은 그대로 남아요.</p>
      {sourceError && (
        <div className="un-book-actions">
          <p className="un-book-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            {sourceError}
          </p>
          <button type="button" className="un-btn is-text is-sm" onClick={() => setAttempt((n) => n + 1)}>
            다시 불러오기
          </button>
        </div>
      )}
      {!source ? (
        !sourceError && <p className="un-book-note">불러오는 중…</p>
      ) : (
        <fieldset className="un-recast-body" disabled={!!working}>
          {partial && (
            <p className="un-book-note is-box">
              분석이 끝난 {formatCount(source.chapterCount)}개 회차만 바꿔요. 나머지 회차는 들어가지 않아요.
            </p>
          )}
          <div className="un-recast-tools">
            <span>
              인물 {formatCount(speakers.length)}명 · {formatCount(source.chapterCount)}개 회차
            </span>
            <span className="un-recast-tool-links">
              {canDesign && bulkTargets.length > 0 && (
                <button type="button" className="un-listen-link" onClick={designAll}>
                  {bulkLabel}
                </button>
              )}
              {Object.keys(rows).length > 0 && (
                <button type="button" className="un-listen-link" onClick={reset}>
                  모두 그대로
                </button>
              )}
            </span>
          </div>
          {designer && !selectionEngines.length && (
            <p className="un-book-note is-box">
              새 목소리를 만들려면 목소리를 정할 배정 AI 모델이 필요해요. 분석 모델 연결에서 추가해 주세요.
            </p>
          )}
          <ul className="un-recast-list">
            {sorted.map((v) => (
              <CastRow
                key={v.speakerId}
                speaker={v}
                row={rowOf(v)}
                plan={effective(v)}
                voices={voices}
                label={label}
                canDesign={canDesign && v.speakerId !== NARRATOR}
                designFull={full}
                listen={listen(v)}
                listenError={previewError(v)}
                onPlan={(plan) => choosePlan(v, plan)}
                onVoice={(voiceId) => setRow(v, { voiceId })}
              />
            ))}
          </ul>
          {paidSample && <p className="un-book-note">유료 목소리는 처음 들을 때 짧은 샘플 요금이 나올 수 있어요.</p>}
          {full && <p className="un-book-note">한 번에 {MAX_DESIGN}명까지 새로 만들 수 있어요.</p>}
          {designIds.length > 0 && designer && (
            <div className="un-cast-mode">
              <SelectionModelField value={selectionId} engines={selectionEngines} onChange={setSelectionChoice} />
              <p className="un-book-note">
                본문을 보고 성별·나이·말투에 맞는 목소리를 정해 <b>{designer.name}</b>에서 만들어요. 만든 목소리는
                보관함에 저장돼요.
              </p>
            </div>
          )}
          <div className="un-recast-summary" aria-label="바뀌는 내용">
            <dl>
              <div className={cx(changedSpeakers.length > 0 && 'is-on')}>
                <dt>바뀜</dt>
                <dd>
                  {changedSpeakers.length ? (
                    <>
                      {formatCount(changedSpeakers.length)}명
                      {designIds.length ? ` · 새로 만들기 ${formatCount(designIds.length)}명` : ''}
                      <small>{changedSpeakers.map((v) => v.name).join(', ')}</small>
                    </>
                  ) : (
                    '없음'
                  )}
                </dd>
              </div>
              <div>
                <dt>그대로</dt>
                <dd>{formatCount(kept)}명</dd>
              </div>
              <div>
                <dt>지금 음성</dt>
                <dd>지우지 않고 그대로 둬요</dd>
              </div>
              {batchChanged && (
                <div className="is-on">
                  <dt>만드는 방식</dt>
                  <dd>{batchAudio ? '이어지는 대사 묶어서' : '개별 구간으로 나눠서'}</dd>
                </div>
              )}
            </dl>
            {characterChanged && (
              <label className="un-book-ack un-cast-toggle">
                <input type="checkbox" checked={applyToBook} onChange={(e) => setApplyToBook(e.target.checked)} />
                <span>
                  다음 회차에도 바꾼 목소리 쓰기
                  <small className="un-book-note">
                    {applyToBook
                      ? designIds.length
                        ? '이 작품의 인물 목소리도 바뀌어요. 새로 만드는 인물은 만들어진 뒤에 반영돼요.'
                        : '이 작품의 인물 목소리도 바뀌어요.'
                      : '이번 음성에만 적용하고, 작품 목소리는 그대로 둬요.'}
                    {narratorChanged ? ' 내레이터는 이번 음성에만 바뀌어요.' : ''}
                  </small>
                </span>
              </label>
            )}
            {!characterChanged && narratorChanged && <p className="un-book-note">내레이터는 이번 음성에만 바뀌어요.</p>}
          </div>

          {(showActing || instructable.length > 0) && (
            <div className="un-recast-acting" role="group" aria-label="장면 연기">
              <h5>장면 연기</h5>
              {showActing && (
                <label className="un-cast-field">
                  <span>
                    감정·속도 표시<small>목소리는 바뀌지 않아요</small>
                  </span>
                  <select
                    aria-label="장면 연기"
                    value={actingMode}
                    onChange={(e) => {
                      setCreated(false);
                      setActingChoice(e.target.value as ActingMode);
                    }}
                  >
                    <option value="preserve">{source.hasActing ? '지금 표시 그대로' : '연기 없이'}</option>
                    {/* With every span tagged, filling gaps would be the same as keeping them. */}
                    {(needsActing || actingMode === 'auto') && (
                      <option value="auto">{source.hasActing ? '빠진 부분만 새로 분석' : 'AI로 분석해서 넣기'}</option>
                    )}
                    {source.hasActing && <option value="off">연기 빼기</option>}
                  </select>
                </label>
              )}
              {showActing && actingMode === 'auto' && needsActing && (
                <label className="un-cast-field">
                  <span>연기 분석 모델</span>
                  <select
                    aria-label="연기 분석 모델"
                    value={actingEngineId ?? ''}
                    onChange={(e) => {
                      setCreated(false);
                      setActingEngineChoice(e.target.value || undefined);
                    }}
                  >
                    {!actingEngineId && <option value="">모델 고르기</option>}
                    {analysisEngines?.map((e) => (
                      <option key={e.id} value={e.id} disabled={!e.enabled && e.id !== actingEngineId}>
                        {e.name} · {e.modelId}
                        {e.paid ? ' · 유료' : ''}
                      </option>
                    ))}
                  </select>
                  {analysisEngines && source.actingEngineId && !hinted && (
                    <small className="un-book-note">원래 분석 모델이 없어요. 다시 골라 주세요.</small>
                  )}
                </label>
              )}
              {instructable.length > 0 && (
                <Directions
                  speakers={instructable}
                  values={directions}
                  captured={(v) => v.instructions ?? ''}
                  onChange={(speakerId, value) => {
                    setCreated(false);
                    setDirections((current) => ({ ...current, [speakerId]: value }));
                  }}
                />
              )}
            </div>
          )}

          {(batchAvailable || source.batched) && (
            <div className="un-recast-acting" role="group" aria-label="요청 묶기">
              <h5>요청 묶기</h5>
              <BatchAudioToggle
                checked={batchAudio}
                partial={!speakers.every((v) => batchable(capability(v)))}
                disabled={!batchAvailable}
                onChange={(on) => {
                  setCreated(false);
                  setBatchChoice(on);
                }}
              />
              {source.batched && (
                <p className="un-book-note">
                  {batchAudio
                    ? '원래 음성도 묶어서 만들었어요.'
                    : '원래 음성은 묶어서 만들었어요. 끄면 개별 구간으로 나눠 다시 만들어요.'}
                </p>
              )}
            </div>
          )}
          {dropped.length > 0 && (
            <p className="un-book-note">
              {dropped.map((v) => v.name).join(', ')}: 고른 목소리가 말투 지시를 지원하지 않아 지시 없이 만들어요.
            </p>
          )}
          {problem && <p className="un-book-note">{problem}</p>}
          {created && !fresh && (
            <p className="un-book-note is-box" role="status">
              새 음성을 만들기 시작했어요. 목록 위쪽에서 진행 상황을 볼 수 있어요.
            </p>
          )}
          {fresh && (
            <div className="un-book-estimate" aria-label="만들기 확인">
              <dl>
                <div>
                  <dt>회차</dt>
                  <dd>{formatCount(fresh.chapterCount)}</dd>
                </div>
                <div>
                  <dt>구간</dt>
                  <dd>{formatCount(fresh.itemCount)}</dd>
                </div>
                <div>
                  <dt>낭독 글자</dt>
                  <dd>{formatCount(fresh.characters)}</dd>
                </div>
                {fresh.recastCharacters !== undefined && (
                  <div>
                    <dt>새로 만들 인물</dt>
                    <dd>{formatCount(fresh.recastCharacters)}</dd>
                  </div>
                )}
              </dl>
              <ul className="un-cast-plan" aria-label="이번에 쓰는 모델">
                {fresh.selectionModelLabel && (
                  <li>
                    <span>목소리 배정</span>
                    <b>{fresh.selectionModelLabel}</b>
                  </li>
                )}
                {fresh.recastCharacters !== undefined && designer && (
                  <li>
                    <span>새 목소리</span>
                    <b>{designer.name}</b>
                  </li>
                )}
                {input?.batchAudio && (
                  <li>
                    <span>요청 묶기</span>
                    <b>켬</b>
                  </li>
                )}
                {fresh.actingAnalysis && (
                  <li>
                    <span>연기 분석</span>
                    <b>{actingEngine?.name ?? '분석 모델'} · 빠진 부분만</b>
                  </li>
                )}
              </ul>
              {fresh.paid && (
                <label className="un-book-ack">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>유료 API 요금이 나올 수 있어요. 확인했어요.</span>
                </label>
              )}
            </div>
          )}
          {error && (
            <p className="un-book-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              {error}
            </p>
          )}
          <div className="un-book-actions">
            {fresh ? (
              <>
                <button
                  type="button"
                  className="un-btn is-primary is-sm"
                  onClick={() => void runCreate()}
                  disabled={!!working || !!problem || (fresh.paid && !ack)}
                  aria-busy={working === 'create' || undefined}
                >
                  {working === 'create' ? '시작하는 중' : '새 음성 만들기'}
                </button>
                <button
                  type="button"
                  className="un-btn is-text is-sm"
                  onClick={() => setEstimate(undefined)}
                  disabled={!!working}
                >
                  취소
                </button>
              </>
            ) : (
              <button
                type="button"
                className="un-btn is-primary is-sm"
                onClick={() => void runEstimate()}
                disabled={!!working || !!problem}
                aria-busy={working === 'estimate' || undefined}
              >
                {working === 'estimate' ? '확인하는 중' : '범위·요금 확인'}
              </button>
            )}
          </div>
        </fieldset>
      )}
    </section>
  );
}

function CastRow({
  speaker: v,
  row,
  plan,
  voices,
  label,
  canDesign,
  designFull,
  listen,
  listenError,
  onPlan,
  onVoice,
}: {
  speaker: Speaker;
  row: Row;
  /** What will actually be sent, which may differ from the tapped choice (e.g. same voice re-picked). */
  plan: Plan;
  voices: readonly PlainTTSVoice[];
  label(id: string): string;
  canDesign: boolean;
  designFull: boolean;
  /** Renders a sample button for a listed voice: the current one, or the one picked below. */
  listen?(voiceId: string, which: 'now' | 'pick'): ReactNode;
  listenError?: string;
  onPlan(plan: Plan): void;
  onVoice(voiceId: string): void;
}) {
  const name = useId();
  const narrator = v.speakerId === NARRATOR;
  const options: [Plan, string][] = [
    ['keep', '그대로'],
    ['swap', '다른 목소리'],
    ...(canDesign ? [['design', '새로 만들기'] as [Plan, string]] : []),
  ];
  const tapped = row.plan === 'design' && !canDesign ? 'keep' : row.plan;
  const listed = voices.some((item) => item.id === row.voiceId);
  return (
    <li className={cx('un-recast-row', plan !== 'keep' && 'is-changed')}>
      <div className="un-recast-head">
        <b>{v.name}</b>
        {!narrator && v.importance && <span className="un-recast-badge">{IMPORTANCE[v.importance]}</span>}
        {v.pinned && <span className="un-recast-badge">직접 지정</span>}
        {v.designed && <span className="un-recast-badge">만든 목소리</span>}
        <small>{formatCount(v.itemCount)}개 구간</small>
      </div>
      <div className="un-recast-voice">
        <span>{label(v.voiceId)}</span>
        {listen?.(v.voiceId, 'now')}
        {plan !== 'keep' && (
          <>
            <ArrowRight size={13} aria-hidden="true" />
            <b>{plan === 'design' ? '새 목소리' : label(row.voiceId)}</b>
          </>
        )}
      </div>
      <div className="un-seg" role="radiogroup" aria-label={`${v.name} 목소리`}>
        {options.map(([value, text]) => {
          const off = value === 'design' && designFull && tapped !== 'design';
          return (
            <label key={value} className={cx(tapped === value && 'is-on', off && 'is-off')}>
              <input
                type="radio"
                name={name}
                value={value}
                checked={tapped === value}
                disabled={off}
                onChange={() => onPlan(value)}
              />
              {text}
            </label>
          );
        })}
      </div>
      {tapped === 'swap' && (
        <div className="un-recast-pick">
          <select aria-label={`${v.name} 새 목소리`} value={row.voiceId} onChange={(e) => onVoice(e.target.value)}>
            {!listed && <option value={row.voiceId}>{row.voiceId} · 목록에 없음</option>}
            {voices.map((item) => (
              <option key={item.id} value={item.id}>
                {[label(item.id), item.providerName ?? item.providerId].filter(Boolean).join(' · ')}
                {item.id === v.voiceId ? ' · 지금' : ''}
              </option>
            ))}
          </select>
          {listen?.(row.voiceId, 'pick')}
        </div>
      )}
      {listenError && (
        <small className="un-book-error" role="alert">
          {listenError}
        </small>
      )}
      {tapped === 'design' && (
        <small className="un-book-note">
          {v.pinned || v.designed ? '지금 목소리 대신 ' : ''}본문에 맞춰 새 목소리를 만들어요.
        </small>
      )}
    </li>
  );
}

/** Sample button: plays on press only, and the same press stops it or cancels a sample still loading. */
function PreviewButton({ name, phase, onClick }: { name: string; phase?: 'loading' | 'playing'; onClick(): void }) {
  return (
    <button
      type="button"
      className={cx('un-recast-play', phase && 'is-on')}
      aria-label={`${name} 미리듣기`}
      aria-pressed={!!phase}
      aria-busy={phase === 'loading' || undefined}
      onClick={onClick}
    >
      {phase === 'loading' ? (
        <LoaderCircle size={13} className="un-spin" aria-hidden="true" />
      ) : phase === 'playing' ? (
        <Square size={12} fill="currentColor" aria-hidden="true" />
      ) : (
        <Play size={12} fill="currentColor" aria-hidden="true" />
      )}
      <span>{phase === 'loading' ? '불러오는 중' : phase === 'playing' ? '정지' : '듣기'}</span>
    </button>
  );
}

/** Per-character manual direction: optional acting, folded until asked for or already written. */
function Directions({
  speakers,
  values,
  captured,
  onChange,
}: {
  speakers: readonly Speaker[];
  values: Record<string, string>;
  captured(v: Speaker): string;
  onChange(speakerId: string, value: string): void;
}) {
  const written = speakers.filter((v) => (values[v.speakerId] ?? captured(v)).trim()).length;
  return (
    <details className="un-cast-options un-recast-directions" open={written > 0 || undefined}>
      <summary>
        인물별 말투 직접 적기<small>{written ? `${written}명 적음` : '선택'}</small>
      </summary>
      {speakers.map((v) => {
        const value = values[v.speakerId] ?? captured(v);
        return (
          <div key={v.speakerId} className="un-cast-field">
            <span>{v.name}</span>
            <textarea
              aria-label={`${v.name} 말투`}
              rows={2}
              maxLength={2000}
              value={value}
              placeholder="예: 지친 듯 조용히, 끝으로 갈수록 단호하게"
              onChange={(e) => onChange(v.speakerId, e.target.value)}
            />
            <div className="un-chip-row" role="group" aria-label={`${v.name} 말투 예시`}>
              {ACTING_EXAMPLES.map((cue) => {
                const added = value.includes(cue);
                const next = value.trim() ? `${value.trimEnd()}, ${cue}` : cue;
                return (
                  <button
                    key={cue}
                    type="button"
                    className={cx('un-chip', added && 'is-active')}
                    disabled={added || next.length > 2000}
                    onClick={() => onChange(v.speakerId, next)}
                  >
                    {cue}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <small className="un-book-note">적은 인물만 그 말투로 다시 만들어요. 지원하는 목소리에만 보여요.</small>
    </details>
  );
}
