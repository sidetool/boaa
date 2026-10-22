import type { HTMLAttributes } from 'react';
import './reader-chapter-end.css';

export interface ReaderChapterEndProps {
  /** '화' for text chapters, '회차' for comic sections. */
  readonly unit: '화' | '회차';
  /** Title of the following chapter; absent at the last chapter. */
  readonly nextTitle?: string;
  readonly hasPrevious: boolean;
  /** The scroll boundary is armed: one more downward scroll opens the next chapter. */
  readonly armed: boolean;
  /** Some chapter switch is on its way; it may be either direction, so the wording stays neutral. */
  readonly busy?: boolean;
  /** Comic pages always sit on a dark canvas; text follows the reading theme. */
  readonly tone?: 'reading' | 'comic';
  /** Extra attributes for the root, such as the scroll boundary data hooks. */
  readonly rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>;
  onPrevious(): void;
  onNext(): void;
}

/**
 * 회차 끝: the quiet centred "다음 화 · title" line the reader always had, now the only way on. The title is
 * the button and the line under it answers the scroll gesture, so the end never shows the same choice twice.
 */
export function ReaderChapterEnd({
  unit,
  nextTitle,
  hasPrevious,
  armed,
  busy = false,
  tone = 'reading',
  rootProps,
  onPrevious,
  onNext,
}: ReaderChapterEndProps) {
  const hasNext = nextTitle !== undefined;
  return (
    <footer
      {...rootProps}
      className={[
        'chapter-nav reader-chapter-end',
        tone === 'comic' && 'is-comic',
        armed && hasNext && !busy && 'is-armed',
        busy && 'is-busy',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hasNext ? (
        <>
          <button
            type="button"
            className="reader-chapter-end-next"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onNext}
          >
            <span>다음 {unit}</span>
            <strong>{nextTitle}</strong>
          </button>
          <small className="reader-chapter-end-cue" aria-live="polite">
            {busy ? '이동 중…' : armed ? '한 번 더 아래로 스크롤' : '마지막까지 읽었습니다'}
          </small>
        </>
      ) : (
        <p className="reader-chapter-end-last">마지막 {unit}입니다</p>
      )}
      {hasPrevious && (
        <button type="button" className="reader-chapter-end-previous" disabled={busy} onClick={onPrevious}>
          이전 {unit}
        </button>
      )}
    </footer>
  );
}
