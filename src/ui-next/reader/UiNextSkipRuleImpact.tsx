import { useEffect, useRef, useState } from 'react';
import type { SpokenTextRule } from '../../domain/types';
import type { SpokenTextRuleImpactSummary } from '../../features/tts/spoken-text-rule-impact';
import { formatCount } from '../../utils/format';

/** Checks how the saved skip rules change the whole book. Reads text only; no audio is made. */
export default function UiNextSkipRuleImpact({
  rules,
  inspect,
}: {
  readonly rules: readonly SpokenTextRule[];
  inspect(signal: AbortSignal): Promise<SpokenTextRuleImpactSummary>;
}) {
  const signature = rules
    .filter((rule) => rule.enabled && rule.kind.startsWith('skip_') && rule.pattern.trim())
    .map((rule) => `${rule.id}:${rule.updatedAt}:${rule.kind}:${rule.pattern}`)
    .join('|');
  const [summary, setSummary] = useState<SpokenTextRuleImpactSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controllerRef = useRef<AbortController>();
  // A changed rule set makes the last answer stale.
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    setSummary(undefined);
    setError(undefined);
    setBusy(false);
  }, [signature]);
  useEffect(() => () => controllerRef.current?.abort(), []);
  if (!signature) return null;

  const check = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await inspect(controller.signal);
      if (!controller.signal.aborted) setSummary(next);
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(caught instanceof Error && caught.message ? caught.message : '책 전체 영향을 확인하지 못했어요.');
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
        setBusy(false);
      }
    }
  };

  return (
    <div className="un-listen-impact" aria-live="polite">
      <div className="un-listen-row">
        <span className="un-listen-label">이 작품에서 빠지는 문단</span>
        <button
          type="button"
          className="un-btn is-ghost is-sm"
          aria-label="책 전체 건너뛰기 영향 확인"
          disabled={busy}
          onClick={() => void check()}
        >
          {busy ? '확인 중…' : '확인'}
        </button>
      </div>
      {error && <p className="un-listen-note is-danger">{error}</p>}
      {summary && (
        <>
          <p className="un-listen-note">
            {formatCount(summary.scannedParagraphCount)}개 문단 중 {formatCount(summary.affectedParagraphCount)}개에
            적용 · 통째로 건너뜀 {formatCount(summary.fullySkippedParagraphCount)}개
          </p>
          {summary.samples.length > 0 && (
            <ul className="un-listen-rules">
              {summary.samples.map((sample) => (
                <li key={`${sample.chapterTitle}:${sample.paragraphIndex}:${sample.source}`}>
                  <span>
                    <b>{sample.source}</b>
                    <small>
                      {sample.chapterTitle} · {sample.paragraphIndex + 1}번째 문단
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
