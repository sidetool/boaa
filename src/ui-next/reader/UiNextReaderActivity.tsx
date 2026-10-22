import { AlertCircle } from 'lucide-react';
import { cx } from '../components/primitives';
import './reader-activity.css';

export interface ReaderActivity {
  /** busy: a request the reader asked for is still pending; warning: it ended without finishing. */
  readonly tone: 'busy' | 'warning';
  readonly label: string;
  /** Short progress such as "12/40". */
  readonly detail?: string;
}

/**
 * ui-next 읽기 중 대기 표시: a small translucent pill in the top corner. It never takes taps, so page
 * turns and selection keep working under it, and short waits finish before it fades in.
 */
export function UiNextReaderActivity({ activity }: { activity?: ReaderActivity }) {
  if (!activity) return null;
  return (
    <p
      className={cx('un-reader-activity', activity.tone === 'warning' && 'is-warning')}
      role="status"
      aria-live="polite"
    >
      {activity.tone === 'busy' ? (
        <span className="un-reader-activity-spinner" aria-hidden="true" />
      ) : (
        <AlertCircle size={13} aria-hidden="true" />
      )}
      <span>{activity.label}</span>
      {activity.detail && <small>{activity.detail}</small>}
    </p>
  );
}
