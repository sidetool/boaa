import { useEffect, useRef, useState } from 'react';
import type { BookVoiceAssignment } from '../../providers/voice-library';
import type { SpeakerGenerationJob, SpeakerGenerationPort } from '../../providers/speaker-generation';
import type { PlainTTSVoice } from '../../providers/plain-tts';

export default function UiNextBookVoices({
  job,
  port,
  voices,
}: {
  job: SpeakerGenerationJob;
  port: SpeakerGenerationPort;
  voices: readonly PlainTTSVoice[];
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<BookVoiceAssignment[]>(),
    [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [revision, setRevision] = useState(0);
  const working = useRef(false);
  useEffect(() => {
    if (!open || !port.castings) return;
    const c = new AbortController();
    port.castings(job.id, c.signal).then(
      (v) => {
        if (!c.signal.aborted) setRows(v);
      },
      (e) => {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : '배정을 불러오지 못했어요.');
      },
    );
    return () => c.abort();
  }, [open, job.id, port, revision]);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const change = async (row: BookVoiceAssignment, voiceId: string) => {
    if (working.current || !port.assign) return;
    working.current = true;
    const signal = lifetime.current.signal;
    setBusy(row.speakerId);
    setError(undefined);
    try {
      await port.assign(job.id, row.speakerId, voiceId, signal);
      if (!signal.aborted) setRevision((r) => r + 1);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : '배정을 저장하지 못했어요.');
    } finally {
      working.current = false;
      if (!signal.aborted) setBusy(undefined);
    }
  };
  if (!port.castings) return null;
  return (
    <details className="un-cast-options" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>인물 목소리</summary>
      {error && (
        <p role="alert" className="un-book-error">
          {error}
        </p>
      )}
      {open &&
        (!rows ? (
          <p className="un-book-note">불러오는 중…</p>
        ) : rows.length === 0 ? (
          <p className="un-book-note">분석이 끝나면 자동으로 배정된 목소리가 보여요.</p>
        ) : (
          <>
            <p className="un-book-note">
              만들기를 멈춘 뒤 바꿀 수 있어요. 다음에 계획할 회차와 새 생성 작업부터 적용하고, 이미 만들어진 구간은
              그대로예요.
            </p>
            {[...rows]
              .sort(
                (a, b) =>
                  (a.importance === 'major' ? 0 : a.importance === 'supporting' ? 1 : 2) -
                  (b.importance === 'major' ? 0 : b.importance === 'supporting' ? 1 : 2),
              )
              .map((row) => (
                <label className="un-cast-field" key={row.speakerId}>
                  <span>
                    {row.name}
                    {row.pinned ? ' · 직접 지정' : ''}
                  </span>
                  <select
                    aria-label={`${row.name} 목소리`}
                    value={row.voiceId}
                    disabled={!!busy || !['paused', 'failed', 'completed'].includes(job.status)}
                    onChange={(e) => void change(row, e.target.value)}
                  >
                    {!voices.some((v) => v.id === row.voiceId) && (
                      <option value={row.voiceId}>{row.alias || row.voiceId} · 목록에 없음</option>
                    )}
                    {voices
                      .filter((v) => job.castVoiceIds?.includes(v.id) || v.id === row.voiceId)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                  </select>
                  {row.description && <small className="un-book-note">{row.description}</small>}
                </label>
              ))}
          </>
        ))}
    </details>
  );
}
