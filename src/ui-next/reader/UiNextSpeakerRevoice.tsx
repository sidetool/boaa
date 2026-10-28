import { AlertCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type { SpeakerEngine } from '../../providers/speaker-engine';
import type {
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerRevoiceEstimate,
  SpeakerRevoiceInput,
  SpeakerRevoiceSource,
} from '../../providers/speaker-generation';
import type { LibraryVoice, SpeakerCastingOptions, VoiceDesignProvider } from '../../providers/voice-library';
import { formatCount } from '../../utils/format';
import { cx } from '../components/primitives';
import { CastingRoles, ChoiceCards, designerFor, VoiceDesignFields, voiceDesigners } from './UiNextCastingOptions';

type Draft = Record<string, { voiceId: string; instructions: string }>;
type ActingMode = NonNullable<SpeakerRevoiceInput['acting']>['mode'];
/** Short delivery cues; they never change who the voice sounds like. */
const ACTING_EXAMPLES = ['조용히 속삭이듯', '지친 듯', '긴장해서 빠르게', '단호하고 차갑게', '밝고 들뜬', '울먹이며'];
/** Gemini 3.8 Flash TTS takes per-line style separately from the stored voice; guidance is shown only for these. */
const GEMINI_38 = new Set(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
const isGemini38 = (voice?: PlainTTSVoice) =>
  voice?.instructionsSupported === true && GEMINI_38.has(voice.modelId ?? voice.model?.modelId ?? '');
const STOPPED: readonly SpeakerGenerationJob['status'][] = ['paused', 'failed', 'completed'];
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;

/**
 * 음성 다시 만들기: a new audio-only job from this job's captured plan. It never edits the book's
 * assignments, never re-runs speaker finding or identity, and keeps the old audio.
 * Model calls happen only on explicit choices: 'auto' acting for untagged spans (analysis model) and
 * natural voice creation for unchanged characters (selection model + voice design).
 */
export default function UiNextSpeakerRevoice({
  job,
  port,
  voices,
  library,
  engines,
  designers,
  onCreated,
}: {
  job: SpeakerGenerationJob;
  port: SpeakerGenerationPort;
  voices: readonly PlainTTSVoice[];
  /** All model connections: analysis ones add acting tags, selection ones plan new voices. */
  engines?: readonly SpeakerEngine[];
  /** Voice design connections for natural voice creation. */
  designers?: readonly VoiceDesignProvider[];
  /** Labels only; descriptions are never sent as acting directions. */
  library?: readonly LibraryVoice[];
  /** Reloads the parent job list; it must not start playback. */
  onCreated(): void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SpeakerRevoiceSource>();
  const [sourceError, setSourceError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  // Undefined until the person picks: the default follows the source (see defaultMode).
  const [actingChoice, setActingChoice] = useState<ActingMode>();
  const [actingEngineChoice, setActingEngineChoice] = useState<string>();
  // New voices per character: off by default; turning it off keeps the draft for turning it back on.
  const [recastOn, setRecastOn] = useState(false);
  const [recast, setRecast] = useState<SpeakerCastingOptions>();
  // Per-character manual directions stay folded until asked for or already written.
  const [manual, setManual] = useState<ReadonlySet<string>>(new Set());
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

  useEffect(() => {
    if (!open || !available || !stopped || !port.revoiceSource) return;
    const c = new AbortController();
    setSourceError(undefined);
    port.revoiceSource(job.id, c.signal).then(
      (next) => {
        if (c.signal.aborted) return;
        setSource(next);
        // A reload adds newly planned speakers; choices already made here stay as they are.
        setDraft((current) => {
          const merged = { ...current };
          for (const v of next.voices)
            merged[v.speakerId] ??= { voiceId: v.voiceId, instructions: v.instructions ?? '' };
          return merged;
        });
      },
      (e) => {
        if (!c.signal.aborted) setSourceError(message(e, '이 작업의 목소리를 불러오지 못했어요.'));
      },
    );
    return () => c.abort();
  }, [open, available, port, job.id, job.itemCount, stopped, attempt]);

  const catalog = (id: string) => voices.find((v) => v.id === id);
  const analysisEngines = engines?.filter((e) => e.purpose !== 'casting');
  const selectionEngines = engines?.filter((e) => e.purpose === 'casting') ?? [];
  // The original analysis model is only a hint: if it is gone, the person picks one.
  const hinted = analysisEngines?.some((e) => e.id === source?.actingEngineId) ? source?.actingEngineId : undefined;
  const actingEngineId = actingEngineChoice ?? hinted;
  const actingEngine = analysisEngines?.find((e) => e.id === actingEngineId);
  const usableDesigners = voiceDesigners(designers);
  const canRecast = selectionEngines.some((e) => e.enabled) && usableDesigners.length > 0;
  const recasting = recastOn && recast ? recast : undefined;
  const toggleRecast = (on: boolean) => {
    setCreated(false);
    setRecastOn(on);
    if (on && !recast)
      setRecast({
        engineId: selectionEngines.find((e) => e.enabled)?.id,
        autoDesign: true,
        designMode: 'characters',
        designProviderId: usableDesigners[0]?.id,
        designModelId: usableDesigners[0]?.modelId,
        maxDesignedVoices: 4,
      });
  };
  const patchRecast = (next: Partial<SpeakerCastingOptions>) => {
    setCreated(false);
    setRecast((current) => current && { ...current, ...next });
  };
  // Spans without tags; older sources omit it, so untagged means needed.
  const needsActing = source ? (source.needsActing ?? !source.hasActing) : false;
  const showActing = !!source?.hasActing || voices.some((v) => v.autoActingSupported === true);
  const capturedSupported =
    !!source?.voices.length && source.voices.every((v) => catalog(v.voiceId)?.autoActingSupported === true);
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
    ...(recasting ? { casting: recasting } : {}),
    voices: source.voices.map((v) => {
      const d = draft[v.speakerId] ?? { voiceId: v.voiceId, instructions: v.instructions ?? '' };
      const text = d.instructions.trim();
      return {
        speakerId: v.speakerId,
        voiceId: d.voiceId,
        ...(catalog(d.voiceId)?.instructionsSupported === true && text ? { instructions: text } : {}),
      };
    }),
  };
  const changed = (speakerId: string) => {
    const before = source?.voices.find((v) => v.speakerId === speakerId);
    const after = input?.voices.find((v) => v.speakerId === speakerId);
    return (
      !!before &&
      !!after &&
      (before.voiceId !== after.voiceId || (before.instructions ?? '') !== (after.instructions ?? ''))
    );
  };
  const changes = source?.voices.filter((v) => changed(v.speakerId)).length ?? 0;
  const missing = input?.voices.some((v) => !catalog(v.voiceId));
  // Automatic acting tags are applied only through voices the server marks as capable.
  const acted = actingMode === 'auto' || (actingMode === 'preserve' && !!source?.hasActing);
  const actingUnsupported = acted
    ? (source?.voices ?? []).filter((v, index) => catalog(input!.voices[index].voiceId)?.autoActingSupported !== true)
    : [];
  const problem = !stopped
    ? '만들기를 멈추거나 끝난 뒤 바꿀 수 있어요.'
    : missing
      ? '목록에 없는 목소리를 다른 목소리로 바꿔 주세요.'
      : actingUnsupported.length
        ? `자동 연기를 지원하지 않는 목소리가 있어요 (${actingUnsupported.map((v) => v.name).join(', ')}). 목소리를 바꾸거나 자동 연기를 빼 주세요.`
        : actingMode === 'auto' && needsActing && !actingEngine
          ? '연기를 분석할 모델을 골라 주세요.'
          : actingMode === 'auto' && needsActing && !actingEngine?.enabled
            ? '고른 분석 모델이 꺼져 있어요.'
            : recasting && !selectionEngines.some((e) => e.id === recasting.engineId && e.enabled)
              ? '목소리 선정 모델을 골라 주세요.'
              : recasting && !designerFor(recasting, designers ?? [])
                ? '목소리 제작 연결을 다시 골라 주세요.'
                : changes === 0 && actingMode === 'preserve' && !recasting
                  ? '바꿀 목소리나 연기를 고르면 확인할 수 있어요.'
                  : undefined;
  const inputKey = input ? JSON.stringify(input) : '';
  const fresh = estimate?.key === inputKey ? estimate.value : undefined;
  useEffect(() => {
    setAck(false);
    setError(undefined);
  }, [inputKey]);
  const edit = (speakerId: string, next: Partial<Draft[string]>) => {
    const captured = source?.voices.find((v) => v.speakerId === speakerId);
    setCreated(false);
    // Clearing the text keeps the field open instead of folding it mid-edit.
    if (next.instructions !== undefined) setManual((current) => new Set(current).add(speakerId));
    setDraft((current) => ({
      ...current,
      [speakerId]: {
        ...(current[speakerId] ?? { voiceId: captured?.voiceId ?? '', instructions: captured?.instructions ?? '' }),
        ...next,
      },
    }));
  };

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
      if (!c.signal.aborted) setError(message(e, '다시 만들 범위를 확인하지 못했어요.'));
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
      // The request may have reached the server: show the list as it is instead of sending it again.
      setError(
        `${message(e, '새 음성 작업을 만들지 못했어요.')} 목록을 다시 불러왔어요. 같은 내용으로 다시 눌러도 작업이 중복으로 생기지 않아요.`,
      );
      onCreated();
    } finally {
      creating.current = false;
      if (run.current === c) setWorking(undefined);
    }
  };

  // Hidden while the source job is running; the open state and draft survive until it stops again.
  if (!available || !stopped) return null;
  const option = (v: PlainTTSVoice) => {
    const saved = library?.find((item) => item.voiceId === v.id);
    return [saved?.alias || v.label, saved?.timbre, v.providerName ?? v.providerId].filter(Boolean).join(' · ');
  };
  const partial = source && (job.planningComplete === false || source.chapterCount < job.chapterCount);
  const anySupported = voices.some((v) => v.instructionsSupported === true);
  return (
    <details className="un-cast-options un-revoice" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>음성 다시 만들기</summary>
      {open && (
        <>
          <p className="un-book-note">
            이 작업에서 찾은 화자와 인물 연결을 그대로 쓰고 음성만 새 작업으로 만들어요. 화자 찾기·인물 연결은 다시 하지
            않고, 지금 음성과 작품의 인물 배정은 바뀌지 않아요.
          </p>
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
            <>
              <p className="un-book-meta">
                {formatCount(source.chapterCount)}개 회차 · {formatCount(source.itemCount)}개 구간
              </p>
              {partial && (
                <p className="un-book-note is-box">
                  이 작업은 계획이 끝난 {formatCount(source.chapterCount)}개 회차·{formatCount(source.itemCount)}개
                  구간만 다시 만들어요. 아직 분석하지 않은 나머지 회차는 포함하지 않아요.
                </p>
              )}
              <fieldset className="un-revoice-fields" disabled={!stopped || !!working}>
                <div className="un-revoice-row">
                  <span className="un-revoice-label">인물 목소리</span>
                  <ChoiceCards
                    label="인물 목소리"
                    value={recastOn ? 'create' : 'keep'}
                    onChange={(next) => toggleRecast(next === 'create')}
                    options={[
                      {
                        value: 'keep',
                        title: '지금 목소리 그대로',
                        tag: '모델 요청 없음',
                        body: '아래에서 인물별로 직접 바꿀 수 있어요.',
                      },
                      {
                        value: 'create',
                        title: '인물마다 새로 만들기',
                        tag: '선정 모델 + 제작',
                        body: '이 작업의 원문으로 선정 모델이 인물의 목소리 특징을 정리하면 Gemini 3.8 Flash TTS가 새 목소리를 만들어요.',
                        disabled: !canRecast,
                        reason:
                          '목소리 선정 모델과 Gemini 3.8 Flash TTS(gemini-3.8-flash-tts) 연결이 있어야 해요. BOAA의 이 기능은 이 모델에서만 지원해요.',
                      },
                    ]}
                  />
                  {recasting && (
                    <div className="un-cast-mode">
                      <label className="un-cast-field">
                        <span>
                          목소리 선정 모델<small>본문을 읽는 언어 모델</small>
                        </span>
                        <select
                          aria-label="목소리 선정 모델"
                          value={recasting.engineId ?? ''}
                          onChange={(e) => patchRecast({ engineId: e.target.value || undefined })}
                        >
                          {!selectionEngines.some((e) => e.id === recasting.engineId) && (
                            <option value={recasting.engineId ?? ''}>
                              {recasting.engineId ? '목록에 없는 선정 모델' : '선정 모델 고르기'}
                            </option>
                          )}
                          {selectionEngines.map((e) => (
                            <option key={e.id} value={e.id} disabled={!e.enabled}>
                              {e.name} · {e.modelId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <VoiceDesignFields
                        value={recasting}
                        designers={designers ?? []}
                        disabled={false}
                        onChange={patchRecast}
                      />
                      <CastingRoles budget={recasting.maxDesignedVoices} revoice />
                      <small className="un-book-note">
                        새 작업 안에서만 바뀌어요. 원래 음성과 작품의 인물 배정, 화자 분석은 그대로예요.
                      </small>
                    </div>
                  )}
                </div>
                {showActing && (
                  <div className="un-revoice-row">
                    <label className="un-cast-field">
                      <span>자동 연기</span>
                      <select
                        aria-label="자동 연기"
                        value={actingMode}
                        onChange={(e) => {
                          setCreated(false);
                          setActingChoice(e.target.value as ActingMode);
                        }}
                      >
                        <option value="preserve">
                          {source.hasActing ? '지금 연기 표시 그대로 쓰기' : '자동 연기 없이 만들기'}
                        </option>
                        {/* With every span tagged, filling gaps would be the same as keeping them. */}
                        {(needsActing || actingMode === 'auto') && (
                          <option value="auto">
                            {source.hasActing ? '빠진 구간만 분석해 채우기' : '분석 모델로 연기 표시하기'}
                          </option>
                        )}
                        {source.hasActing && <option value="off">자동 연기 빼기</option>}
                      </select>
                    </label>
                    {actingMode === 'auto' && needsActing && (
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
                          {!actingEngineId && <option value="">분석 모델 고르기</option>}
                          {analysisEngines?.map((e) => (
                            <option key={e.id} value={e.id} disabled={!e.enabled && e.id !== actingEngineId}>
                              {e.name} · {e.modelId}
                              {e.paid ? ' · 유료 API' : ''}
                            </option>
                          ))}
                        </select>
                        {analysisEngines && source.actingEngineId && !hinted && (
                          <small className="un-book-note">원래 분석 모델을 찾을 수 없어요. 다시 골라 주세요.</small>
                        )}
                      </label>
                    )}
                    <small className="un-book-note">
                      {actingMode === 'auto'
                        ? needsActing
                          ? '이미 있는 표시는 그대로 두고, 표시가 없는 구간만 고른 분석 모델로 감정·말투·속도를 채워요. 화자 찾기·인물 연결은 다시 하지 않아요. 분석 모델 요금이 추가될 수 있어요.'
                          : '모든 구간에 이미 연기 표시가 있어 분석 모델을 부르지 않아요.'
                        : actingMode === 'off'
                          ? '자동 연기 표시를 빼고 만들어요. 분석 모델은 부르지 않아요.'
                          : source.hasActing
                            ? needsActing
                              ? '원래 분석의 표시를 그대로 쓰고, 표시가 없는 구간은 연기 없이 만들어요. 분석 모델은 부르지 않아요.'
                              : '원래 분석에서 표시한 감정·말투·속도를 그대로 써요. 분석 모델은 부르지 않아요.'
                            : '이 작업에는 자동 연기 표시가 없어요. 분석 모델은 부르지 않고 고른 목소리로만 만들어요.'}
                    </small>
                  </div>
                )}
                {source.voices.map((v) => {
                  const d = draft[v.speakerId] ?? { voiceId: v.voiceId, instructions: v.instructions ?? '' };
                  const chosen = catalog(d.voiceId);
                  const supported = chosen?.instructionsSupported === true;
                  return (
                    <div key={v.speakerId} className="un-revoice-row">
                      <label className="un-cast-field">
                        <span>
                          {v.name}
                          <small>
                            {formatCount(v.itemCount)}개 구간{changed(v.speakerId) ? ' · 바뀜' : ''}
                          </small>
                        </span>
                        <select
                          aria-label={`${v.name} 새 목소리`}
                          value={d.voiceId}
                          onChange={(e) => edit(v.speakerId, { voiceId: e.target.value })}
                        >
                          {!chosen && <option value={d.voiceId}>{d.voiceId} · 목록에 없음</option>}
                          {voices.map((item) => (
                            <option key={item.id} value={item.id}>
                              {option(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {supported && !manual.has(v.speakerId) && !d.instructions.trim() ? (
                        <button
                          type="button"
                          className="un-btn is-text is-sm un-revoice-manual"
                          onClick={() => setManual((current) => new Set(current).add(v.speakerId))}
                        >
                          직접 연기 지시 추가
                        </button>
                      ) : supported ? (
                        <>
                          <label className="un-cast-field">
                            <span>
                              직접 연기 지시<small>선택 · 이 인물에만</small>
                            </span>
                            <textarea
                              aria-label={`${v.name} 연기 지시`}
                              rows={2}
                              maxLength={2000}
                              value={d.instructions}
                              placeholder="예: 지친 듯 조용히, 끝으로 갈수록 단호하게"
                              onChange={(e) => edit(v.speakerId, { instructions: e.target.value })}
                            />
                          </label>
                          <div className="un-chip-row" role="group" aria-label={`${v.name} 연기 예시`}>
                            {ACTING_EXAMPLES.map((cue) => {
                              const added = d.instructions.includes(cue);
                              const next = d.instructions.trim() ? `${d.instructions.trimEnd()}, ${cue}` : cue;
                              return (
                                <button
                                  key={cue}
                                  type="button"
                                  className={cx('un-chip', added && 'is-active')}
                                  disabled={added || next.length > 2000}
                                  onClick={() => edit(v.speakerId, { instructions: next })}
                                >
                                  {cue}
                                </button>
                              );
                            })}
                          </div>
                          {isGemini38(chosen) && (
                            <small className="un-book-note">
                              Gemini 3.8: 이 인물의 대사를 어떤 감정·속도로 읽을지 짧게 적어요. 성별·나이·음색은 고른
                              목소리에서 정해지고 지시로 바뀌지 않아요. 다른 목소리가 필요하면 위에서 고르거나 보관함의
                              ‘설명으로 만들기’를 사용해요.
                            </small>
                          )}
                        </>
                      ) : (
                        d.instructions.trim() && (
                          <small className="un-book-note">
                            이 목소리의 TTS 연결은 연기 지시를 지원하지 않아 지시 없이 만들어요. 적은 지시는 지원하는
                            목소리로 바꾸면 다시 쓰여요.
                          </small>
                        )
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <p className="un-book-note">
                {anySupported
                  ? '직접 연기 지시는 필요한 인물에만 더하는 선택 설정이에요. 보관함 설명이나 자동 연기 표시는 이 칸에 넣지 않으며, 바꾸면 해당 인물의 음성을 새로 만들어요.'
                  : '직접 연기 지시 칸은 지원하는 TTS 연결의 목소리를 고를 때만 보여요.'}
              </p>
              {problem && <p className="un-book-note">{problem}</p>}
              {created && !fresh && (
                <p className="un-book-note" role="status">
                  새 음성 작업을 만들었어요. 목록에서 진행을 확인할 수 있어요.
                </p>
              )}
              {fresh && (
                <div className="un-book-estimate" aria-label="다시 만들기 확인">
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
                        <dt>새 목소리 인물</dt>
                        <dd>{formatCount(fresh.recastCharacters)}</dd>
                      </div>
                    )}
                  </dl>
                  {(fresh.selectionModelLabel || !!fresh.maxDesignedVoices) && (
                    <p className="un-book-voice">
                      목소리 선정 <b>{fresh.selectionModelLabel ?? '선정 모델'}</b>
                      {fresh.maxDesignedVoices ? ` · 최대 ${fresh.maxDesignedVoices}명 새 목소리` : ''}
                    </p>
                  )}
                  {fresh.actingAnalysis && (
                    <p className="un-book-voice">
                      연기 분석 <b>{actingEngine?.name ?? '분석 모델'}</b> · 표시가 없는 구간만
                    </p>
                  )}
                  {fresh.paid && (
                    <label className="un-book-ack">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      <span>
                        {fresh.actingAnalysis || recasting
                          ? `${
                              recasting && fresh.actingAnalysis
                                ? '음성 서비스, 목소리 선정·제작과 연기 분석 모델'
                                : recasting
                                  ? '음성 서비스와 목소리 선정·제작'
                                  : '음성 서비스와 연기 분석 모델'
                            }의 API 사용 요금이 발생할 수 있어요. 화자 찾기·인물 연결은 다시 하지 않아요.`
                          : '음성 서비스의 API 사용 요금이 발생할 수 있어요. 분석 모델은 부르지 않아요.'}
                      </span>
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
                    className="un-btn is-ghost is-sm"
                    onClick={() => void runEstimate()}
                    disabled={!!working || !!problem}
                    aria-busy={working === 'estimate' || undefined}
                  >
                    {working === 'estimate' ? '확인하는 중' : '다시 만들 범위 확인'}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </details>
  );
}
