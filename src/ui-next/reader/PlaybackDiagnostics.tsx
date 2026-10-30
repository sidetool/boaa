import { useState } from 'react';
import { playbackDiagnostics } from '../../providers/playback-diagnostics';

export default function PlaybackDiagnostics() {
  const [message, setMessage] = useState('');
  const [manual, setManual] = useState('');
  const copy = async () => {
    const report = playbackDiagnostics.report();
    if (!report) {
      setMessage('이 화면을 연 뒤 재생한 기록이 없어요.');
      return;
    }
    try {
      await navigator.clipboard.writeText(report);
      setManual('');
      setMessage('복사했어요. 문제를 문의할 때 함께 보내 주세요.');
    } catch {
      setManual(report);
      setMessage('아래 기록을 길게 눌러 복사해 주세요.');
    }
  };
  return (
    <section className="un-listen-group" aria-label="재생 문제 확인">
      <div className="un-listen-group-head">
        <h3>재생 문제 확인</h3>
      </div>
      <p className="un-listen-note">
        재생이 멈췄다면 앱을 닫기 전에 기록을 복사해 주세요. 본문·음성·계정 정보는 포함하지 않아요.
      </p>
      <button type="button" className="un-btn is-ghost is-sm" onClick={() => void copy()}>
        재생 진단 복사
      </button>
      {message && (
        <p className="un-listen-note" role="status">
          {message}
        </p>
      )}
      {manual && (
        <textarea
          aria-label="직접 복사할 재생 진단"
          readOnly
          rows={4}
          value={manual}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </section>
  );
}
