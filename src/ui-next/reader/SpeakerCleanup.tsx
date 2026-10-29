import { AlertCircle, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  SpeakerCleanupOptions,
  SpeakerCleanupPreview,
  SpeakerCleanupResult,
  SpeakerGenerationPort,
} from '../../providers/speaker-generation';
import { formatBytes, formatCount } from '../../utils/format';

const NONE: SpeakerCleanupOptions = { audio: false, settings: false, analysis: false };
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message && error.name !== 'AbortError' ? error.message : fallback;

/**
 * 작품 초기화·삭제: three independent book-wide choices, none picked at first. Shared connections and the
 * account voice library are never touched; analysis is kept unless chosen. The server decides what may go
 * together (blockedReason); this page only shows it.
 */
export default function SpeakerCleanup({
  port,
  locked,
  onRun,
}: {
  port: SpeakerGenerationPort;
  /** A job is making audio: cleanup waits until it is stopped. */
  locked: boolean;
  /** Runs the cleanup with the parent's saved-choice handling and returns what the server removed. */
  onRun(options: SpeakerCleanupOptions, fingerprint: string): Promise<SpeakerCleanupResult>;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SpeakerCleanupOptions>(NONE);
  const [preview, setPreview] = useState<{ key: string; value: SpeakerCleanupPreview }>();
  const [previewError, setPreviewError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const key = JSON.stringify(options);
  const any = options.audio || options.settings || options.analysis;
  useEffect(() => {
    if (!open || !port.previewCleanup) return;
    const c = new AbortController();
    setPreviewError(undefined);
    port.previewCleanup(options, c.signal).then(
      (value) => !c.signal.aborted && setPreview({ key, value }),
      (e) => {
        if (!c.signal.aborted) setPreviewError(message(e, '지울 내용을 확인하지 못했어요.'));
      },
    );
    return () => c.abort();
    // options is fully described by key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, port, key, revision]);
  if (!port.previewCleanup || !port.cleanup) return null;
  const fresh = preview?.key === key ? preview.value : undefined;
  // Counts do not depend on the choice; the last answer keeps them on screen while a new one loads.
  const counts = preview?.value;
  const blocked = fresh?.blockedReason;
  const toggle = (name: keyof SpeakerCleanupOptions) => {
    setError(undefined);
    setOptions((current) => ({ ...current, [name]: !current[name] }));
  };
  const close = () => {
    setOpen(false);
    setOptions(NONE);
    setError(undefined);
  };
  const run = async () => {
    if (!fresh || blocked || !any || locked || working) return;
    setWorking(true);
    setError(undefined);
    try {
      const result = await onRun(options, fresh.fingerprint);
      const parts = [
        options.audio && `음성 작업 ${formatCount(result.removedJobs)}개`,
        options.settings && `인물 배정 ${formatCount(result.removedAssignments)}명`,
        options.analysis && `분석 기록 ${formatCount(result.removedAnalyses)}개`,
      ].filter(Boolean);
      setDone(`정리했어요: ${parts.join(', ')}. 위에서 새로 만들 수 있어요.`);
      close();
    } catch (e) {
      // The book may have changed meanwhile (e.g. 409): read again instead of retrying the old plan.
      setError(message(e, '초기화하지 못했어요. 다시 확인해 주세요.'));
      setRevision((n) => n + 1);
    } finally {
      setWorking(false);
    }
  };
  const row = (name: keyof SpeakerCleanupOptions, title: string, detail: string | undefined, note: string) => (
    <label className="un-book-ack un-cast-toggle un-cleanup-option">
      <input type="checkbox" checked={options[name]} disabled={working} onChange={() => toggle(name)} />
      <span>
        {title}
        {detail && <b className="un-cleanup-count">{detail}</b>}
        <small className="un-book-note">{note}</small>
      </span>
    </label>
  );
  return (
    <section className="un-book-group" aria-labelledby="un-cast-cleanup">
      <div className="un-book-group-head">
        <h3 id="un-cast-cleanup">초기화·삭제</h3>
      </div>
      {done && (
        <p className="un-book-note is-box" role="status">
          {done}
        </p>
      )}
      {!open ? (
        <>
          <p className="un-book-note">
            이 작품의 음성·목소리 설정·화자 분석을 골라서 지우고 처음부터 다시 만들 수 있어요.
          </p>
          <div className="un-book-actions">
            <button
              type="button"
              className="un-btn is-ghost is-sm"
              onClick={() => {
                setDone(undefined);
                setOpen(true);
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              초기화·삭제
            </button>
          </div>
        </>
      ) : (
        <div className="un-book-confirm un-cleanup" role="group" aria-label="초기화·삭제 선택">
          <p>지울 항목을 고르세요.</p>
          {row(
            'audio',
            '만든 음성·생성 작업',
            counts && `${formatCount(counts.jobCount)}개 · ${formatBytes(counts.audioBytes)}`,
            '이 작품에서 만든 음성 파일과 작업 목록을 지워요.',
          )}
          {row(
            'settings',
            '인물 목소리 배정·생성 설정',
            counts && `인물 ${formatCount(counts.assignmentCount)}명`,
            '직접 지정한 목소리까지 비우고 이 작품의 생성 설정을 기본값으로 되돌려요. 분석 모델 선택은 남아요.',
          )}
          {row(
            'analysis',
            '화자 분석 기록',
            counts && `${formatCount(counts.analysisCount)}개`,
            '누가 말하는지 찾은 기록과 인물 연결을 지워요. 다음에 만들 때 다시 분석해요.',
          )}
          <p className="un-book-note">
            {options.analysis ? '' : '화자 분석 기록은 남아요. 다음에 만들 때 다시 써요. '}
            목소리 보관함과 TTS·분석 모델 연결은 그대로예요.
            {(options.audio || options.analysis) && ' 지운 음성과 분석은 되돌릴 수 없어요.'}
          </p>
          {locked ? (
            <p className="un-book-note is-box">만드는 중인 작업을 멈춘 뒤 초기화할 수 있어요.</p>
          ) : (
            blocked && <p className="un-book-note is-box">{blocked}</p>
          )}
          {(previewError || error) && (
            <p className="un-book-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              {error ?? previewError}
            </p>
          )}
          <div className="un-book-actions">
            <button
              type="button"
              className="un-btn is-sm un-book-danger"
              disabled={!any || !fresh || !!blocked || locked || working}
              aria-busy={working || undefined}
              onClick={() => void run()}
            >
              {working ? '정리하는 중' : '선택한 항목 지우기'}
            </button>
            <button type="button" className="un-btn is-text is-sm" disabled={working} onClick={close}>
              취소
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
