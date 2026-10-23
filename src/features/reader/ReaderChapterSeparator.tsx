import type { HTMLAttributes } from 'react';
import './reader-chapter-separator.css';

/** Fixed block size of the separator in CSS pixels, so a virtualizer can reserve it before it renders. */
export const READER_CHAPTER_SEPARATOR_HEIGHT = 112;

export type ReaderChapterSeparatorStatus = 'ready' | 'loading' | 'error' | 'end';

export interface ReaderChapterSeparatorProps {
  /** '화' for text chapters, '회차' for comic sections. */
  readonly unit: '화' | '회차';
  /** The chapter that just ended, as the reader shows it ("12화 · 제목"). */
  readonly currentTitle: string;
  /** The chapter that follows; may be absent while it is still loading and is ignored at the end. */
  readonly nextTitle?: string;
  readonly status: ReaderChapterSeparatorStatus;
  /** Offered only with `status: 'error'`. */
  onRetry?(): void;
  /** Comic sections sit on the viewer's dark canvas; text follows the reading theme. */
  readonly tone?: 'reading' | 'comic';
  /** Extra attributes for the root, such as boundary data hooks. */
  readonly rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>;
}

/**
 * 이어 읽기 경계: a thin rule naming the chapter that ended, then the one that follows. It keeps one height in
 * every state so the scroll position never jumps while the next chapter loads in underneath.
 */
export function ReaderChapterSeparator({
  unit,
  currentTitle,
  nextTitle,
  status,
  onRetry,
  tone = 'reading',
  rootProps,
}: ReaderChapterSeparatorProps) {
  const next = status === 'end' ? undefined : nextTitle;
  return (
    <section
      aria-label={`${currentTitle} 끝`}
      {...rootProps}
      className={['reader-chapter-separator', tone === 'comic' && 'is-comic', `is-${status}`]
        .filter(Boolean)
        .join(' ')}
      aria-busy={status === 'loading' || undefined}
      data-chapter-separator-status={status}
    >
      <p className="reader-chapter-separator-rule">
        <span className="reader-chapter-separator-current">
          <span>{currentTitle}</span>끝
        </span>
      </p>
      <p className="reader-chapter-separator-label" aria-live="polite">
        {status === 'end' ? (
          `마지막 ${unit}입니다`
        ) : status === 'loading' ? (
          `다음 ${unit} 불러오는 중…`
        ) : status === 'error' ? (
          <>
            다음 {unit}를 불러오지 못했어요
            {onRetry && (
              <button type="button" className="reader-chapter-separator-retry" onClick={onRetry}>
                다시 시도
              </button>
            )}
          </>
        ) : (
          `다음 ${unit}`
        )}
      </p>
      {next !== undefined && <strong className="reader-chapter-separator-next">{next}</strong>}
    </section>
  );
}

/** Fixed block size of the previous-chapter mark in CSS pixels; the same in every state. */
export const READER_CHAPTER_LEAD_HEIGHT = 40;

/**
 * `idle`: a previous chapter exists but is not being fetched. `start`: this is the first chapter. Both keep the
 * space and show nothing, so finding out there is no previous chapter never moves the text under the reader.
 */
export type ReaderChapterLeadStatus = 'idle' | 'loading' | 'error' | 'start';

export interface ReaderChapterLeadProps {
  /** '화' for text chapters, '회차' for comic sections. */
  readonly unit: '화' | '회차';
  readonly status: ReaderChapterLeadStatus;
  /** Offered only with `status: 'error'`. */
  onRetry?(): void;
  readonly tone?: 'reading' | 'comic';
  readonly rootProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>;
}

/**
 * 이전 화 표시: the top of a continuous scroll. Silent while reading; one short line only while the previous
 * chapter loads above or failed to.
 */
export function ReaderChapterLead({ unit, status, onRetry, tone = 'reading', rootProps }: ReaderChapterLeadProps) {
  return (
    <div
      {...rootProps}
      className={['reader-chapter-lead', tone === 'comic' && 'is-comic', `is-${status}`].filter(Boolean).join(' ')}
      aria-busy={status === 'loading' || undefined}
      data-chapter-lead-status={status}
    >
      <p className="reader-chapter-separator-label" aria-live="polite">
        {status === 'loading' ? (
          `이전 ${unit} 불러오는 중…`
        ) : status === 'error' ? (
          <>
            이전 {unit}를 불러오지 못했어요
            {onRetry && (
              <button type="button" className="reader-chapter-separator-retry" onClick={onRetry}>
                다시 시도
              </button>
            )}
          </>
        ) : null}
      </p>
    </div>
  );
}
