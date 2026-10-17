import { Check, ChevronDown, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BookEnrichmentController } from '../../features/book-enrichment/useBookEnrichmentController';
import { BookCover } from '../../features/library/BookCover';
import { mayCloseMetadataEditor } from '../../features/library/metadata-editor-close';
import type { LibraryManagementController } from '../../features/library/useLibraryManagementController';
import { useMetadataEditorDraft, type MetadataEditorDraft } from '../../features/library/useMetadataEditorDraft';
import { useDismissibleLayer } from '../../shared/ui/use-dismissible-layer';
import { cx, Segmented } from '../components/primitives';
import { GeneratedCover } from './WorkTile';
import { UiNextEnrichment } from './UiNextEnrichment';
import '../styles/tokens.css';
import '../styles/kit.css';
import './metadata.css';

function DraftCover({ draft }: { draft: MetadataEditorDraft }) {
  const book = draft.book!;
  const coverClass = `cover-${(book.coverSeed % 6) + 1}`;
  if (draft.coverPreviewUrl)
    return (
      <div className="un-cover">
        <img
          src={draft.coverPreviewUrl}
          alt="새 표지 미리보기"
          style={{
            objectFit: draft.fit === 'crop' ? 'cover' : 'contain',
            objectPosition: `${draft.positionX}% ${draft.positionY}%`,
          }}
        />
      </div>
    );
  if (draft.cover.kind === 'remove' || !book.coverAssetId)
    return (
      <GeneratedCover
        novel={{ ...book, title: draft.title || book.title, author: draft.author }}
        coverClass={coverClass}
      />
    );
  return <BookCover novel={book} className={cx('un-cover', coverClass)} />;
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={cx('un-meta-field', wide && 'is-wide')}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** ui-next 작품 정보: auto-fill first, then the fields, as one scrolling page. */
export function UiNextMetadataEditor({
  controller,
  bookEnrichment,
}: {
  controller: LibraryManagementController;
  bookEnrichment: BookEnrichmentController;
}) {
  const draft = useMetadataEditorDraft(controller);
  const layerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const book = draft.book;
  const requestClose = () => {
    if (mayCloseMetadataEditor(draft.dirty, controller.confirmDiscard)) controller.closePanel();
  };
  useDismissibleLayer({
    open: Boolean(book),
    modal: true,
    containerRef: pageRef,
    layerRootRef: layerRef,
    closeDisabled: controller.busy,
    onClose: requestClose,
  });
  if (!book) return null;
  const hasCover = draft.cover.kind === 'replace' || (draft.cover.kind === 'keep' && Boolean(book.coverAssetId));

  return createPortal(
    <div
      ref={layerRef}
      className="ui-next un-meta-layer"
      onClick={(event) => event.target === event.currentTarget && requestClose()}
    >
      <section
        ref={pageRef}
        className="un-meta"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="un-meta-bar">
          <button
            type="button"
            className="un-icon-btn"
            onClick={requestClose}
            disabled={controller.busy}
            aria-label="닫기"
          >
            <X size={22} />
          </button>
          <h2 id={titleId}>작품 정보</h2>
          <button
            type="button"
            className="un-btn is-primary is-sm"
            disabled={!draft.dirty || controller.busy || !draft.title.trim()}
            onClick={() => void draft.save()}
          >
            {controller.busy ? '저장 중…' : '저장'}
          </button>
        </header>

        <div className="un-meta-scroll">
          <div className="un-meta-hero">
            <div className="un-meta-cover">
              <DraftCover draft={draft} />
              <label className="un-meta-cover-pick">
                <ImagePlus size={16} aria-hidden="true" />
                {draft.coverBusy ? '처리 중…' : '표지 바꾸기'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={draft.coverBusy}
                  onChange={(event) => {
                    void draft.selectCover(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
            <div className="un-meta-hero-text">
              <b>{draft.title || '제목 없음'}</b>
              <span>{draft.author || '작가 미상'}</span>
              {draft.tags.length > 0 && (
                <small>
                  {draft.tags
                    .slice(0, 4)
                    .map((tag) => `#${tag}`)
                    .join(' ')}
                  {draft.tags.length > 4 ? ` 외 ${draft.tags.length - 4}` : ''}
                </small>
              )}
              {hasCover && (
                <button type="button" className="un-meta-link is-danger" onClick={draft.removeCover}>
                  <Trash2 size={14} aria-hidden="true" /> 표지 지우기
                </button>
              )}
              {draft.coverError && <p className="un-meta-error">{draft.coverError}</p>}
            </div>
          </div>

          <UiNextEnrichment
            book={book}
            controller={bookEnrichment}
            dirty={draft.dirty}
            saveDraft={draft.save}
            onApplied={() => void controller.refreshOpenMetadata()}
            cover={<DraftCover draft={draft} />}
          />

          <section className="un-meta-section" aria-label="기본 정보">
            <h3>기본 정보</h3>
            <div className="un-meta-grid">
              <Field label="제목" wide>
                <input
                  value={draft.title}
                  maxLength={300}
                  required
                  onChange={(event) => draft.setTitle(event.target.value)}
                />
              </Field>
              <Field label="작가" wide>
                <input
                  value={draft.author}
                  maxLength={300}
                  placeholder="작가 이름"
                  onChange={(event) => draft.setAuthor(event.target.value)}
                />
              </Field>
              <Field label="시리즈">
                <input
                  value={draft.seriesTitle}
                  maxLength={300}
                  placeholder="없음"
                  onChange={(event) => draft.setSeriesTitle(event.target.value)}
                />
              </Field>
              <Field label="권">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  value={draft.seriesIndex}
                  placeholder="–"
                  onChange={(event) => draft.setSeriesIndex(event.target.value)}
                />
              </Field>
            </div>
          </section>

          <section className="un-meta-section" aria-label="소개">
            <h3>소개</h3>
            <textarea
              aria-label="작품 소개"
              value={draft.description}
              rows={5}
              maxLength={20000}
              placeholder="줄거리나 메모를 적어 두세요."
              onChange={(event) => draft.setDescription(event.target.value)}
            />
          </section>

          <section className="un-meta-section" aria-label="태그">
            <h3>태그</h3>
            <div className="un-meta-tags">
              {draft.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="un-meta-tag"
                  onClick={() => draft.removeTag(tag)}
                  aria-label={`${tag} 태그 지우기`}
                >
                  #{tag}
                  <X size={13} aria-hidden="true" />
                </button>
              ))}
              <form
                className="un-meta-tag-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  draft.addTag();
                }}
              >
                <input
                  value={draft.tagDraft}
                  maxLength={80}
                  placeholder="태그 추가"
                  aria-label="추가할 태그"
                  onChange={(event) => draft.setTagDraft(event.target.value)}
                />
                {draft.tagDraft.trim() && (
                  <button type="submit" aria-label="태그 추가">
                    <Plus size={15} />
                  </button>
                )}
              </form>
            </div>
          </section>

          {controller.shelves.length > 0 && (
            <section className="un-meta-section" aria-label="책장">
              <h3>책장</h3>
              <div className="un-meta-shelves">
                {controller.shelves.map((shelf) => {
                  const on = draft.selectedShelfIds.has(shelf.id);
                  return (
                    <button
                      key={shelf.id}
                      type="button"
                      aria-pressed={on}
                      className={cx(on && 'is-on')}
                      onClick={() => draft.toggleShelf(shelf.id)}
                    >
                      <span className="un-meta-shelf-dot" style={{ backgroundColor: shelf.color }} aria-hidden="true" />
                      {shelf.name}
                      {on && <Check size={14} aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <details className="un-meta-more">
            <summary>
              더 보기 <small>언어{hasCover ? ', 표지 위치' : ''}</small>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="un-meta-more-body">
              <Field label="언어">
                <input
                  value={draft.language}
                  placeholder="ko-KR"
                  onChange={(event) => draft.setLanguage(event.target.value)}
                />
              </Field>
              {hasCover && (
                <>
                  <div className="un-meta-field">
                    <span>표지 맞춤</span>
                    <Segmented
                      label="표지 맞춤 방식"
                      value={draft.fit}
                      options={[
                        { value: 'crop', label: '꽉 채우기' },
                        { value: 'contain', label: '원본 비율' },
                      ]}
                      onChange={draft.setFit}
                    />
                  </div>
                  <label className="un-meta-field">
                    <span>가로 위치</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={draft.positionX}
                      onChange={(event) => draft.setPositionX(Number(event.target.value))}
                    />
                  </label>
                  <label className="un-meta-field">
                    <span>세로 위치</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={draft.positionY}
                      onChange={(event) => draft.setPositionY(Number(event.target.value))}
                    />
                  </label>
                </>
              )}
            </div>
          </details>
          {controller.error && <p className="un-meta-error">{controller.error}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
