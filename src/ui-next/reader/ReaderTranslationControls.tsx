import { useEffect, useRef, useState } from 'react';
import type { ReaderTranslationController } from '../../features/translation/use-reader-translation';
import { translationMessage } from '../../translation/contracts';
import { Sheet } from '../components/primitives';
import { Notice } from '../components/prefs';
import { UiNextReaderActivity, type ReaderActivity } from './UiNextReaderActivity';
import '../settings/pages/translation.css';
import './translation.css';
/** Reads the translation request state for the corner pill; the sheet shows the full status while it is open. */
function useTranslationActivity(t: ReaderTranslationController): ReaderActivity | undefined {
  const status = t.result?.status;
  const active = t.busy || status === 'queued' || status === 'running';
  const failed = Boolean(t.error) || status === 'failed';
  const [ended, setEnded] = useState(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      setEnded(false);
      return;
    }
    // Only a request the reader was waiting on reports how it ended; opening a chapter stays quiet
    // and clears a warning that belonged to the previous one.
    if (wasActive.current) setEnded(failed);
    else if (!failed) setEnded(false);
    wasActive.current = false;
  }, [active, failed]);
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setEnded(false), 4000);
    return () => clearTimeout(timer);
  }, [ended]);
  if (t.open) return undefined;
  if (active)
    return {
      tone: 'busy',
      label: t.busy ? '번역 준비 중' : status === 'queued' ? '번역 대기 중' : '번역 중',
      detail: status === 'running' && t.result?.total ? `${t.result.completed}/${t.result.total}` : undefined,
    };
  return ended ? { tone: 'warning', label: '번역을 마치지 못했어요' } : undefined;
}

export function ReaderTranslationControls({
  controller: t,
  listening,
}: {
  controller: ReaderTranslationController;
  listening: boolean;
}) {
  const activity = useTranslationActivity(t);
  if (!t.available) return null;
  const progress = t.result ? `${t.result.completed} / ${t.result.total}문단` : '';
  const active = ['running', 'queued'].includes(t.result?.status ?? '');
  const sameLanguage = Boolean(
    t.sourceLanguage && t.sourceLanguage.split('-')[0] === t.configuration?.settings.targetLanguage.split('-')[0],
  );
  return (
    <>
      <UiNextReaderActivity activity={activity} />
      <Sheet open={t.open} title="작품 번역" onClose={() => t.setOpen(false)}>
        <div className="un-translation-controls">
          <p>원문을 유지하며 번역문으로 바꿔 볼 수 있어요. 긴 회차는 나눠 처리하고, 완료된 문단부터 표시해요.</p>
          <Notice tone="warning">
            선택한 제공자에게 원문이 전송되며 API 요금이 발생할 수 있어요. 엔진·키·요청 한도는 설정의 ‘작품 번역’에서
            바꿀 수 있어요.
          </Notice>
          <label className="un-translation-field">
            <span>원문 언어</span>
            <select
              className="un-input"
              value={t.sourceLanguage}
              onChange={(event) => t.setSourceLanguage(event.target.value)}
            >
              <option value="">자동 판단 · 알 수 없으면 직접 확인</option>
              <option value="ja">일본어</option>
              <option value="en">영어</option>
              <option value="zh">중국어</option>
              <option value="ko">한국어</option>
              <option value="fr">프랑스어</option>
              <option value="de">독일어</option>
              <option value="es">스페인어</option>
            </select>
          </label>
          {sameLanguage && (
            <Notice>원문과 번역할 언어가 같아요. 언어 정보가 잘못됐다면 원문 언어를 바꿔 주세요.</Notice>
          )}
          {!t.sourceLanguage && (
            <Notice>원문 언어를 확신할 수 없어요. 아래 번역 버튼을 누르면 현재 원문을 번역해요.</Notice>
          )}
          {t.result && (
            <p role="status">
              {active
                ? '번역 중'
                : t.result.status === 'complete'
                  ? '서버에 저장됨'
                  : t.result.status === 'cancelled'
                    ? '중지됨'
                    : '일부 번역을 완료하지 못했어요'}{' '}
              · {progress}
            </p>
          )}
          {(t.error || t.result?.error) && (
            <Notice tone="warning">{t.error || translationMessage(t.result?.error)}</Notice>
          )}
          {listening && <Notice>지금 듣기는 원문을 읽고 있어요. 번역문은 듣기를 멈춘 후 볼 수 있어요.</Notice>}
          <div className="un-translation-actions">
            {t.result?.paragraphs.length ? (
              <button className="un-btn is-primary" disabled={listening} onClick={t.showTranslation}>
                저장된 번역 보기
              </button>
            ) : null}
            {t.result?.status !== 'complete' && !active && (
              <button
                className="un-btn is-primary"
                disabled={t.busy || listening || sameLanguage}
                onClick={() => void t.start(t.sourceLanguage)}
              >
                {t.busy ? '준비 중…' : '이번 화만 번역'}
              </button>
            )}
            {active && (
              <button className="un-btn is-ghost" onClick={() => void t.cancel()}>
                번역 중지
              </button>
            )}
            <button
              className="un-btn is-ghost"
              onClick={() => {
                t.showOriginal();
                t.setOpen(false);
              }}
            >
              원문 보기
            </button>
          </div>
          <p className="un-translation-help">
            번역 보기는 스크롤로 표시해요. 번역 중인 문단은 원문이 보이며, 듣기·본문 검색·인용은 원문 기준이에요.
            원문으로 돌아가도 완료된 번역은 서버에 남아요.
          </p>
        </div>
      </Sheet>
    </>
  );
}
