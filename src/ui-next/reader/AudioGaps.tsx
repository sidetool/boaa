import { ShieldAlert } from 'lucide-react';
import type { SavedAudiobook } from '../../providers/plain-audiobook';
import { formatCount } from '../../utils/format';
import { cx } from '../components/primitives';

type AudioGap = NonNullable<SavedAudiobook['blockedAudio']>[number];

// Fixed server wording for a policy refusal (current, then older jobs); the blocked notice already says it.
const BLOCK_MESSAGES = [
  '음성 제공자가 콘텐츠 제한으로 이 구간의 생성을 거절했어요.',
  '음성 제공자의 콘텐츠 제한으로 이 구간을 만들지 못했어요.',
];

/** Silent segments count toward progress; `completedItems` stays the number of real audio files. */
export function audioCounts(item: SavedAudiobook) {
  const skipped = item.skippedItems ?? 0;
  const done = item.completedItems + skipped;
  return { done, skipped, blocked: item.blockedItems ?? 0, remaining: Math.max(0, item.itemCount - done) };
}

/** The job error minus a repeat of the blocked notice; analysis or other failures always stay visible. */
export function visibleError(item: SavedAudiobook) {
  const text = item.error?.trim();
  if (!text || ((item.blockedItems ?? 0) > 0 && BLOCK_MESSAGES.includes(text))) return undefined;
  return item.error;
}

/** A finished job with silent segments must not read as fully voiced. */
export function AudioBadge({ item, label }: { item: SavedAudiobook; label: string }) {
  const skipped = item.skippedItems ?? 0;
  const partial = item.status === 'completed' && skipped > 0;
  return (
    <span className={cx('un-book-badge', `is-${item.status}`, partial && 'is-partial')}>
      {partial ? `완료 · 누락 ${formatCount(skipped)}` : label}
    </span>
  );
}

/** Body of the skip confirmation; `rest` names what is still queued after the skip. */
export function skipBlockedText(item: SavedAudiobook, rest: string) {
  return [
    `콘텐츠 제한 구간 ${formatCount(item.blockedItems ?? 0)}개는 음성 없이 넘기고 ${rest}을 이어서 만들어요.`,
    '이 작업에서 이후 제한되는 구간도 자동으로 넘겨요. 본문은 그대로 보여요.',
    item.paid ? '유료 API 요금이 나올 수 있어요.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Segments the voice service refused on content policy. A plain retry is refused by the server, so the card
 * offers only an explicit skip; skipped ones stay listed so the gaps can be found later.
 */
export function AudioGaps({ item }: { item: SavedAudiobook }) {
  const { blocked, skipped } = audioCounts(item);
  const auto = item.skipBlockedAudio && item.status !== 'completed';
  return (
    <>
      {blocked > 0 && (
        <div className="un-book-gaps is-blocked" role="group" aria-label="콘텐츠 제한 구간">
          <p className="un-book-gaps-head">
            <ShieldAlert size={15} aria-hidden="true" />
            <b>콘텐츠 제한 구간 {formatCount(blocked)}개</b>
          </p>
          <small>음성 서비스가 생성을 거절한 구간이에요. 음성 없이 넘기면 나머지를 계속 만들 수 있어요.</small>
          <GapList gaps={item.blockedAudio} total={blocked} />
        </div>
      )}
      {skipped > 0 && item.skippedAudio?.length ? (
        <details className="un-book-gaps">
          <summary>
            <span>
              <b>음성 없이 넘긴 구간 {formatCount(skipped)}개</b>
              <small>{auto ? '이후 콘텐츠 제한 구간도 자동으로 넘겨요' : '본문은 그대로 보여요'}</small>
            </span>
          </summary>
          <GapList gaps={item.skippedAudio} total={skipped} />
        </details>
      ) : skipped > 0 || auto ? (
        <small className="un-book-meta">
          {skipped > 0 ? `음성 없이 넘긴 구간 ${formatCount(skipped)}개 · ` : ''}
          {auto ? '콘텐츠 제한 구간은 자동으로 넘겨요' : '본문은 그대로 보여요'}
        </small>
      ) : null}
    </>
  );
}

function GapList({ gaps = [], total }: { gaps?: readonly AudioGap[]; total: number }) {
  if (!gaps.length) return null;
  return (
    <>
      <ul className="un-book-gap-list">
        {gaps.map((gap) => (
          <li key={gap.ordinal}>
            <span>{gap.chapterTitle || '제목 없는 회차'}</span>
            <small>작업 내 {formatCount(gap.ordinal + 1)}번 구간</small>
          </li>
        ))}
      </ul>
      {total > gaps.length && (
        <small className="un-book-meta">
          앞 {formatCount(gaps.length)}개만 보여요 · 전체 {formatCount(total)}개
        </small>
      )}
    </>
  );
}
