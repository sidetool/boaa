import { Bookmark, CloudDownload, Highlighter, Search, StickyNote } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { ReaderOutlinePanelProps } from '../../features/annotations/reader-outline-contract';
import { formatCount } from '../../utils/format';
import { cx, Progress } from '../components/primitives';
import './tools.css';

/** ui-next 목차 tab: the chapter list opens on the chapter being read. */
export default function UiNextOutlinePanel(props: ReaderOutlinePanelProps) {
  const currentRef = useRef<HTMLLIElement>(null);
  const { chapters, filteredChapters, currentChapterId, readChapter } = props;

  useLayoutEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div className="un-outline">
      <div className="un-outline-search">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={props.query}
          onChange={(event) => props.setQuery(event.target.value)}
          placeholder={`${formatCount(chapters.length)}화 중에서 찾기`}
          aria-label="화 목록 검색"
        />
      </div>
      {filteredChapters.length === 0 ? (
        <p className="un-outline-empty">검색 결과가 없어요.</p>
      ) : (
        <ol className="un-outline-list">
          {filteredChapters.map((chapter) => {
            const current = chapter.id === currentChapterId;
            const saved = readChapter?.id === chapter.id;
            const read = readChapter !== undefined && chapter.index < readChapter.index;
            const counts = props.annotationCounts.get(chapter.id);
            // Episodes still on the source open by saving them first; they have no length yet.
            const pending = props.pendingChapterIds?.has(chapter.id) ?? false;
            return (
              <li
                key={chapter.id}
                ref={current ? currentRef : undefined}
                className={cx(
                  'un-outline-row',
                  current && 'is-current',
                  read && !current && 'is-read',
                  pending && 'is-pending',
                )}
              >
                <button
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  onClick={() => void props.openChapter(chapter, saved)}
                >
                  <span className="un-outline-index">{chapter.index}</span>
                  <span className="un-outline-text">
                    <b>{chapter.title}</b>
                    <small>
                      {pending ? '열면 서재에 저장돼요' : `${formatCount(chapter.characterCount)}자`}
                      {counts?.bookmarks ? (
                        <i aria-label={`북마크 ${counts.bookmarks}개`}>
                          <Bookmark size={12} aria-hidden="true" />
                          {formatCount(counts.bookmarks)}
                        </i>
                      ) : null}
                      {counts?.highlights ? (
                        <i aria-label={`하이라이트 ${counts.highlights}개`}>
                          <Highlighter size={12} aria-hidden="true" />
                          {formatCount(counts.highlights)}
                        </i>
                      ) : null}
                      {counts?.notes ? (
                        <i aria-label={`메모 ${counts.notes}개`}>
                          <StickyNote size={12} aria-hidden="true" />
                          {formatCount(counts.notes)}
                        </i>
                      ) : null}
                    </small>
                    {saved && !current && props.readChapterProgress > 0 && (
                      <Progress value={props.readChapterProgress} label="읽은 정도" />
                    )}
                  </span>
                  <span className="un-outline-state">
                    {current ? (
                      '읽는 중'
                    ) : read ? (
                      '읽음'
                    ) : pending ? (
                      <CloudDownload size={16} aria-label="저장 전" />
                    ) : (
                      ''
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
