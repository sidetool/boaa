import { ArrowLeft, CloudOff, RefreshCw } from 'lucide-react';
import { cx } from '../components/primitives';
import './document.css';
import './stream-loading.css';

export interface UiNextStreamLoadingProps {
  readonly workTitle?: string;
  readonly episodeTitle?: string;
  readonly error?: string;
  /** pages: comic and webtoon column; text: paragraph lines in the reader's measure. */
  readonly variant?: 'pages' | 'text';
  onRetry?(): void;
  onClose(): void;
}

/**
 * ui-next 회차 준비 화면: the viewer's own header and stage, so nothing jumps when pages arrive.
 * Pages are not drawn here; a quiet column stands in until the layout is known.
 */
export function UiNextStreamLoading({
  workTitle,
  episodeTitle,
  error,
  variant = 'pages',
  onRetry,
  onClose,
}: UiNextStreamLoadingProps) {
  const title = workTitle || episodeTitle || '';
  const episode = workTitle && episodeTitle && episodeTitle !== workTitle ? episodeTitle : undefined;
  return (
    <main
      className={cx('fixed-doc-screen un-kit un-stream-wait', variant === 'pages' ? 'is-comic' : 'is-text')}
      aria-busy={!error}
    >
      <header className="fixed-doc-header">
        <div className="fixed-doc-title-group">
          <button type="button" className="fixed-doc-icon-button" onClick={onClose} aria-label="회차 목록으로">
            <ArrowLeft size={19} />
          </button>
          <div>
            <strong>{title}</strong>
            {episode && <small className="un-stream-wait-episode">{episode}</small>}
          </div>
        </div>
      </header>
      {error ? (
        <div className="un-stream-wait-problem" role="alert">
          <CloudOff size={28} aria-hidden="true" />
          <strong>회차를 열지 못했어요</strong>
          <p>{error}</p>
          <div>
            {onRetry && (
              <button type="button" className="un-btn is-primary" onClick={onRetry}>
                <RefreshCw size={16} aria-hidden="true" />
                다시 시도
              </button>
            )}
            <button type="button" className="un-btn is-ghost" onClick={onClose}>
              목록으로
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="un-stream-wait-bar" aria-hidden="true" />
          {variant === 'text' ? (
            <div className="un-stream-wait-stage" aria-hidden="true">
              {[0, 1, 2, 3].map((paragraph) => (
                <p key={paragraph}>
                  <span />
                  <span />
                  <span />
                </p>
              ))}
            </div>
          ) : (
            <div className="un-stream-wait-stage" aria-hidden="true">
              <span />
              <span />
            </div>
          )}
          <p className="un-stream-wait-pill" role="status">
            <span className="un-stream-wait-spinner" aria-hidden="true" />
            {episode ?? '회차'} 여는 중
          </p>
        </>
      )}
    </main>
  );
}
