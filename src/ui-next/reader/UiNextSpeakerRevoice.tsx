import { AlertCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PlainTTSVoice } from '../../providers/plain-tts';
import type {
  SpeakerGenerationJob,
  SpeakerGenerationPort,
  SpeakerRevoiceEstimate,
  SpeakerRevoiceInput,
  SpeakerRevoiceSource,
} from '../../providers/speaker-generation';
import type { LibraryVoice } from '../../providers/voice-library';
import { formatCount } from '../../utils/format';

type Draft = Record<string, { voiceId: string; instructions: string }>;
const STOPPED: readonly SpeakerGenerationJob['status'][] = ['paused', 'failed', 'completed'];
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;

/**
 * 음성 다시 만들기: a new audio-only job from this job's captured plan. It never edits the book's
 * assignments, never calls analysis or casting models, and keeps the old audio.
 */
export default function UiNextSpeakerRevoice({
  job,
  port,
  voices,
  library,
  onCreated,
}: {
  job: SpeakerGenerationJob;
  port: SpeakerGenerationPort;
  voices: readonly PlainTTSVoice[];
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
  const input: SpeakerRevoiceInput | undefined = source && {
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
  const problem = !stopped
    ? '만들기를 멈추거나 끝난 뒤 바꿀 수 있어요.'
    : missing
      ? '목록에 없는 목소리를 다른 목소리로 바꿔 주세요.'
      : changes === 0
        ? '바꿀 목소리나 연기 지시를 고르면 확인할 수 있어요.'
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
            이 작업에서 찾은 화자와 인물 연결을 그대로 쓰고 음성만 새 작업으로 만들어요. 분석·목소리 선정 모델은 다시
            부르지 않고, 지금 음성과 작품의 인물 배정은 바뀌지 않아요.
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
                      {supported ? (
                        <label className="un-cast-field">
                          <span>
                            연기 지시<small>선택</small>
                          </span>
                          <textarea
                            aria-label={`${v.name} 연기 지시`}
                            rows={2}
                            maxLength={2000}
                            value={d.instructions}
                            placeholder="예: 낮게 가라앉은 목소리로, 서두르지 말고 단호하게"
                            onChange={(e) => edit(v.speakerId, { instructions: e.target.value })}
                          />
                        </label>
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
                  ? '연기 지시는 고른 목소리에 말투·감정을 더하는 합성 설정이에요. 보관함 설명은 자동으로 넣지 않으며, 바꾸면 해당 인물의 음성을 새로 만들어요.'
                  : '연기 지시 칸은 지원하는 TTS 연결의 목소리를 고를 때만 보여요.'}
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
                  </dl>
                  {fresh.paid && (
                    <label className="un-book-ack">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      <span>음성 서비스의 API 사용 요금이 발생할 수 있어요. 분석 모델은 부르지 않아요.</span>
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
