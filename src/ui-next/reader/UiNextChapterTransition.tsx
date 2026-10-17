import { AlertCircle, RefreshCw } from 'lucide-react';
import { cx } from '../components/primitives';
import './chapter-transition.css';

export interface UiNextChapterTransitionProps {
  /** Episode being opened, e.g. "10화". */
  readonly title: string;
  /** importing: the episode is being saved from the source first; opening: it is local and loading. */
  readonly phase: 'importing' | 'opening';
  readonly error?: string;
  onRetry?(): void;
}

/**
 * ui-next 회차 전환 표시: the current page stays put; a hairline at the top and a small pill say the next
 * episode is on its way, so a slow source never looks like a frozen or reset reader.
 */
export function UiNextChapterTransition({ title, phase, error, onRetry }: UiNextChapterTransitionProps) {
  return (
    <div className={cx('un-chapter-transition', error && 'has-error')}>
      {!error && <span className="un-chapter-transition-bar" aria-hidden="true" />}
      <p className="un-chapter-transition-pill" role={error ? 'alert' : 'status'}>
        {error ? (
          <>
            <AlertCircle size={16} aria-hidden="true" />
            <span>{title} · 열지 못했어요</span>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                <RefreshCw size={14} aria-hidden="true" />
                다시 시도
              </button>
            )}
          </>
        ) : (
          <>
            <span className="un-chapter-transition-spinner" aria-hidden="true" />
            <span>
              {title} 여는 중{phase === 'importing' && <small>서재에 저장하고 있어요</small>}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
