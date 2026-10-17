import { BookmarkCheck, BookmarkPlus, ClipboardCopy, Download, PenLine, Search } from 'lucide-react';
import { useState } from 'react';
import { AnnotationBookmarkSection } from '../../features/annotations/AnnotationBookmarkSection';
import { AnnotationHighlightSection } from '../../features/annotations/AnnotationHighlightSection';
import { AnnotationNoteSection } from '../../features/annotations/AnnotationNoteSection';
import type { AnnotationsController } from '../../features/annotations/useAnnotationsController';
import '../../features/annotations/annotations-panel.css';
import { cx } from '../components/primitives';
import './tools.css';

/** ui-next 주석 tab: quick actions first, then the saved marks; export waits at the bottom. */
export default function UiNextAnnotationsPanel({ controller }: { controller: AnnotationsController }) {
  const [composing, setComposing] = useState(false);
  const editing = Boolean(controller.editingNoteId);
  const composerOpen = composing || editing || Boolean(controller.noteDraft);
  const bookmarked = Boolean(controller.view.activeBookmark);
  const closeComposer = () => {
    controller.resetEditor();
    setComposing(false);
  };

  return (
    <div className="panel-body annotation-panel un-notes">
      <div className="un-notes-actions">
        <button
          type="button"
          className={cx(bookmarked && 'is-on')}
          aria-pressed={bookmarked}
          onClick={() => void controller.toggleBookmark()}
        >
          {bookmarked ? <BookmarkCheck size={18} aria-hidden="true" /> : <BookmarkPlus size={18} aria-hidden="true" />}
          {bookmarked ? '북마크됨' : '여기 북마크'}
        </button>
        <button
          type="button"
          className={cx(composerOpen && 'is-on')}
          aria-expanded={composerOpen}
          onClick={() => (composerOpen ? closeComposer() : setComposing(true))}
        >
          <PenLine size={18} aria-hidden="true" />
          메모 쓰기
        </button>
      </div>

      {composerOpen && (
        <form
          className="un-notes-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void Promise.resolve(controller.saveNoteDraft()).then(() => setComposing(false));
          }}
        >
          <textarea
            aria-label="메모 내용"
            autoFocus
            value={controller.noteDraft}
            onChange={(event) => controller.setNoteDraft(event.target.value)}
            placeholder={editing ? '메모 내용을 수정하세요.' : '선택한 문장이나 지금 위치에 남길 메모'}
          />
          <div>
            <button type="button" className="un-btn is-text is-sm" onClick={closeComposer}>
              취소
            </button>
            <button type="submit" className="un-btn is-primary is-sm" disabled={!controller.noteDraft.trim()}>
              {editing ? '수정 저장' : '저장'}
            </button>
          </div>
        </form>
      )}

      <div className="un-notes-filter">
        <label className="un-outline-search">
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="주석 검색"
            value={controller.query}
            onChange={(event) => controller.setQuery(event.target.value)}
            placeholder="북마크·하이라이트·메모 검색"
          />
        </label>
        <div className="un-notes-chips">
          <button
            type="button"
            aria-pressed={controller.scope === 'chapter'}
            className={cx(controller.scope === 'chapter' && 'is-active')}
            onClick={() => controller.setScope(controller.scope === 'chapter' ? 'all' : 'chapter')}
          >
            이 화만
          </button>
          <button
            type="button"
            aria-pressed={controller.sort === 'position'}
            className={cx(controller.sort === 'position' && 'is-active')}
            onClick={() => controller.setSort(controller.sort === 'position' ? 'recent' : 'position')}
          >
            본문 순서로
          </button>
        </div>
      </div>

      <AnnotationBookmarkSection controller={controller} />
      <AnnotationHighlightSection controller={controller} />
      <AnnotationNoteSection controller={controller} />

      <div className="un-notes-export">
        <span>내보내기</span>
        <button type="button" onClick={() => void controller.copyMarkdown()}>
          <ClipboardCopy size={15} aria-hidden="true" /> Markdown 복사
        </button>
        <button type="button" onClick={controller.downloadMarkdown}>
          <Download size={15} aria-hidden="true" /> 파일로 저장
        </button>
      </div>
    </div>
  );
}
