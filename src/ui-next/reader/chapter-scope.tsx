import { useState } from 'react';
import { formatCount } from '../../utils/format';
import { Segmented } from '../components/primitives';

export type ChapterScope = 'current' | 'range' | 'all';
type Chapters = readonly { readonly id: string; readonly title: string }[];

/** 이 화 / 범위 / 전체, shared by both 미리 생성하기 pages. Indexes follow reading order. */
export function useChapterScope(chapters: Chapters, currentChapterId?: string) {
  const currentIndex = chapters.findIndex((chapter) => chapter.id === currentChapterId);
  const [chosenScope, setScope] = useState<ChapterScope>(currentIndex >= 0 ? 'current' : 'all');
  const scope: ChapterScope = chosenScope === 'current' && currentIndex < 0 ? 'all' : chosenScope;
  const [from, setFrom] = useState(Math.max(0, currentIndex));
  const [to, setTo] = useState(Math.max(0, currentIndex));
  const selected =
    scope === 'all'
      ? chapters
      : scope === 'range'
        ? chapters.slice(Math.min(from, to), Math.max(from, to) + 1)
        : currentIndex >= 0
          ? [chapters[currentIndex]!]
          : [];
  return { chapters, currentIndex, scope, setScope, from, setFrom, to, setTo, selected };
}

export type ChapterScopeState = ReturnType<typeof useChapterScope>;

export function chapterScopeSummary({ scope, selected, chapters }: ChapterScopeState) {
  return scope === 'current' && selected[0]
    ? selected[0].title || '현재 회차'
    : scope === 'all'
      ? `전체 ${formatCount(chapters.length)}개 회차`
      : `${formatCount(selected.length)}개 회차`;
}

export function ChapterScopeFields({ state }: { state: ChapterScopeState }) {
  const { chapters, currentIndex, scope, setScope, from, setFrom, to, setTo } = state;
  return (
    <>
      <Segmented
        label="만들 범위"
        value={scope}
        options={[
          ...(currentIndex >= 0 ? [{ value: 'current' as const, label: '이 화' }] : []),
          { value: 'range', label: '범위' },
          { value: 'all', label: '전체' },
        ]}
        onChange={setScope}
      />
      {scope === 'range' && (
        <div className="un-book-range">
          <ChapterSelect
            label="시작 회차"
            chapters={chapters}
            value={from}
            onChange={(next) => {
              setFrom(next);
              if (next > to) setTo(next);
            }}
          />
          <span aria-hidden="true">~</span>
          <ChapterSelect
            label="끝 회차"
            chapters={chapters}
            value={to}
            onChange={(next) => {
              setTo(next);
              if (next < from) setFrom(next);
            }}
          />
        </div>
      )}
    </>
  );
}

function ChapterSelect({
  label,
  chapters,
  value,
  onChange,
}: {
  label: string;
  chapters: Chapters;
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {chapters.map((chapter, index) => (
        <option key={chapter.id} value={index}>
          {chapter.title || `${index + 1}화`}
        </option>
      ))}
    </select>
  );
}
