import type { ChapterStructureChapterView } from '@boaa/text-core/chapter-structure';
import { ArrowLeft, Check, Pencil, RotateCcw, Search, Split, Undo2, WandSparkles, X } from 'lucide-react';
import { Fragment, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ChapterSplitMode } from '../../domain/types';
import { structurePreviewWindow } from '../../features/chapter-structure/chapter-structure-view-model';
import {
  candidateKey,
  useChapterStructurePanelModel,
} from '../../features/chapter-structure/use-chapter-structure-panel-model';
import type { ChapterStructureController } from '../../features/chapter-structure/useChapterStructureController';
import { formatCount } from '../../utils/format';
import { cx } from '../components/primitives';
import { EmptyState, Notice, PrefField, PrefFold } from '../components/prefs';
import './chapter-structure.css';

const identity = (chapter: ChapterStructureChapterView) =>
  `${chapter.rawStartOffset}:${chapter.rawEndOffset}:${chapter.title}`;

/** Before/after of the pending change, with how many reading records need a look. */
function Preview({ controller }: { controller: ChapterStructureController }) {
  const preview = controller.preview!;
  const window = useMemo(() => structurePreviewWindow(preview.before, preview.after), [preview]);
  const kept = useMemo(() => new Set(preview.after.map(identity)), [preview.after]);
  const existed = useMemo(() => new Set(preview.before.map(identity)), [preview.before]);
  const risk = preview.impact.readerAnnotationsAtRisk + preview.impact.correctionsForReview;
  return (
    <div className="un-cs-preview">
      <div className="un-cs-stats">
        <div>
          <small>화 수</small>
          <b>
            {preview.before.length} → {preview.after.length}
          </b>
        </div>
        <div>
          <small>그대로인 문단</small>
          <b>{formatCount(preview.impact.preservedParagraphs)}</b>
        </div>
        <div className={cx(risk > 0 && 'is-warn')}>
          <small>확인할 기록</small>
          <b>{formatCount(risk)}</b>
        </div>
      </div>
      {(window.hiddenBefore > 0 || window.hiddenAfter > 0) && (
        <p className="un-cs-muted">바뀌지 않은 앞뒤 화는 줄였어요.</p>
      )}
      <div className="un-cs-compare">
        <section>
          <h4>지금</h4>
          {window.before.map((chapter) => (
            <p key={chapter.id} className={cx(!kept.has(identity(chapter)) && 'is-removed')}>
              <b>{chapter.index}</b>
              <span>{chapter.title}</span>
            </p>
          ))}
        </section>
        <section>
          <h4>바꾼 뒤</h4>
          {window.after.map((chapter) => (
            <p key={chapter.id} className={cx(!existed.has(identity(chapter)) && 'is-added')}>
              <b>{chapter.index}</b>
              <span>{chapter.title}</span>
            </p>
          ))}
        </section>
      </div>
      {preview.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      <div className="un-cs-actions">
        <button type="button" className="un-btn is-ghost" disabled={controller.busy} onClick={controller.clearPreview}>
          돌아가기
        </button>
        <button
          type="button"
          className="un-btn is-primary"
          disabled={controller.busy}
          onClick={() => void controller.applyPreview()}
        >
          바꾸기
        </button>
      </div>
    </div>
  );
}

/** 회차 나누기 편집: join chapters by removing boundaries, split them at heading lines, rename or re-split. */
export default function UiNextChapterStructure({ controller }: { controller: ChapterStructureController }) {
  const model = useChapterStructurePanelModel(controller);
  const { selected } = model;
  const busy = controller.busy;
  useEffect(() => {
    if (!controller.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) controller.closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, busy]);
  if (!controller.open) return null;

  const pending =
    model.addedBoundaries.size > 0
      ? `나눌 곳 ${model.addedBoundaries.size}개`
      : model.removedBoundaries.size > 0
        ? `합칠 곳 ${model.removedBoundaries.size}개`
        : undefined;

  return createPortal(
    <div className="ui-next un-cs" role="dialog" aria-modal="true" aria-label="회차 나누기 편집">
      <header className="un-cs-bar">
        {model.mobilePane === 'editor' && !controller.preview ? (
          <button
            type="button"
            className="un-icon-btn un-cs-back"
            aria-label="회차 목록"
            onClick={() => model.setMobilePane('list')}
          >
            <ArrowLeft size={22} />
          </button>
        ) : null}
        <h2>회차 나누기</h2>
        <button type="button" className="un-icon-btn" aria-label="닫기" disabled={busy} onClick={controller.closePanel}>
          <X size={22} />
        </button>
      </header>

      {!controller.available ? (
        <EmptyState icon={<Split size={22} />} title="여기서는 회차를 다시 나눌 수 없어요" />
      ) : busy && !controller.editor ? (
        <p className="un-cs-loading" aria-busy="true">
          회차를 불러오는 중…
        </p>
      ) : (
        <div className={cx('un-cs-body', `is-${model.mobilePane}`, controller.preview && 'is-previewing')}>
          <section className="un-cs-list" aria-label="지금 회차">
            <div className="un-cs-list-head">
              <span>
                {formatCount(model.chapters.length)}화 ·{' '}
                {controller.editor?.sourceProvenance === 'original' ? '원본' : '복원본'}
              </span>
              <label className="un-cs-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  className="un-input"
                  aria-label="회차 번호나 제목으로 찾기"
                  placeholder="번호나 제목"
                  value={model.query}
                  onChange={(event) => model.setQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="un-cs-scroll">
              {model.filteredChapters.map((chapter, index) => {
                const next = model.filteredChapters[index + 1];
                const joined = model.removedBoundaries.has(chapter.id);
                return (
                  <Fragment key={chapter.id}>
                    <button
                      type="button"
                      className={cx('un-cs-chapter', chapter.id === selected?.id && 'is-active')}
                      onClick={() => model.selectChapter(chapter.id)}
                    >
                      <b>{chapter.index}</b>
                      <span>
                        <strong>{chapter.title}</strong>
                        <small>
                          {formatCount(chapter.characterCount)}자 · {formatCount(chapter.paragraphCount)}문단
                        </small>
                      </span>
                    </button>
                    {next?.index === chapter.index + 1 && (
                      <button
                        type="button"
                        className={cx('un-cs-seam', joined && 'is-joined')}
                        aria-pressed={joined}
                        aria-label={`${chapter.index}화와 ${next.index}화 ${joined ? '나눠 두기' : '합치기'}`}
                        onClick={() => model.toggleBoundaryRemoval(chapter.id)}
                      >
                        <i />
                        <small>{joined ? '합칠 예정' : '합치기'}</small>
                        <i />
                      </button>
                    )}
                  </Fragment>
                );
              })}
              {model.filteredChapters.length === 0 && <p className="un-cs-muted">맞는 회차가 없어요.</p>}
            </div>
            {model.removedBoundaries.size > 0 && (
              <div className="un-cs-dock">
                <span>합칠 곳 {model.removedBoundaries.size}개</span>
                <button
                  type="button"
                  className="un-btn is-primary is-sm"
                  disabled={busy}
                  onClick={() => model.previewCommands(model.removalCommands)}
                >
                  결과 보기
                </button>
              </div>
            )}
          </section>

          <section className="un-cs-editor" aria-label="고른 회차">
            {controller.preview ? (
              <Preview controller={controller} />
            ) : (
              selected && (
                <>
                  <header className="un-cs-selected">
                    <b>{selected.index}화</b>
                    <div>
                      <strong>{selected.title}</strong>
                      <small>
                        {formatCount(selected.characterCount)}자 · {formatCount(selected.paragraphCount)}문단
                      </small>
                    </div>
                  </header>
                  <blockquote className="un-cs-source">{selected.sourcePreview}</blockquote>

                  <section className="un-cs-split">
                    <div className="un-cs-split-head">
                      <div>
                        <strong>여기서 새 회차 시작</strong>
                        <small>새 회차가 시작되는 줄을 골라요.</small>
                      </div>
                      <button
                        type="button"
                        className="un-btn is-text is-sm"
                        onClick={() => model.setShowAllParagraphs((value) => !value)}
                      >
                        {model.showAllParagraphs ? '제목 같은 줄만' : '모든 문단'}
                      </button>
                    </div>
                    {model.visibleCandidates.length ? (
                      <ul className="un-cs-lines">
                        {model.visibleCandidates.map((candidate) => {
                          const on = model.addedBoundaries.has(candidateKey(selected.id, candidate.sourceOffset));
                          return (
                            <li key={candidate.paragraphId}>
                              <button
                                type="button"
                                aria-pressed={on}
                                className={cx(on && 'is-on')}
                                onClick={() => model.toggleBoundaryAddition(candidate)}
                              >
                                <span className="un-cs-check" aria-hidden="true">
                                  {on && <Check size={13} />}
                                </span>
                                <span>
                                  <strong>{candidate.headingTitle || candidate.label}</strong>
                                  <small>{candidate.paragraphIndex}번째 문단</small>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <Notice
                        action={
                          <button
                            type="button"
                            className="un-btn is-text is-sm"
                            onClick={() => model.setShowAllParagraphs(true)}
                          >
                            모든 문단 보기
                          </button>
                        }
                      >
                        제목 같은 줄을 못 찾았어요.
                      </Notice>
                    )}
                    {model.focusedFamily && model.focusedFamilyCandidates.length > 1 && (
                      <Notice
                        action={
                          <button type="button" className="un-btn is-text is-sm" onClick={model.toggleFocusedFamily}>
                            모두 고르기
                          </button>
                        }
                      >
                        같은 모양의 줄이 {model.focusedFamilyCandidates.length}개 있어요.
                      </Notice>
                    )}
                  </section>

                  <PrefFold title="직접 고치기" summary="제목 바꾸기, 이 화부터 다시 나누기">
                    <div className="un-cs-manual">
                      <PrefField label="회차 제목">
                        <input
                          value={model.title}
                          maxLength={160}
                          onChange={(event) => model.setTitle(event.target.value)}
                        />
                      </PrefField>
                      <button
                        type="button"
                        className="un-btn is-ghost is-sm"
                        disabled={busy || !model.title.trim() || model.title.trim() === selected.title}
                        onClick={model.previewRename}
                      >
                        <Pencil size={15} />
                        제목 바꾼 결과 보기
                      </button>
                      <PrefField label="이 화부터 다시 나누기">
                        <select
                          value={model.reparseMode}
                          onChange={(event) => model.setReparseMode(event.target.value as ChapterSplitMode)}
                        >
                          <option value="auto">확실한 제목만</option>
                          <option value="mixed">여러 제목 모양까지</option>
                          <option value="single">나머지를 한 화로</option>
                        </select>
                      </PrefField>
                      <button
                        type="button"
                        className="un-btn is-ghost is-sm"
                        disabled={busy}
                        onClick={model.previewReparse}
                      >
                        <WandSparkles size={15} />
                        다시 나눈 결과 보기
                      </button>
                    </div>
                  </PrefFold>

                  <div className="un-cs-history">
                    <span>확인할 기록 {formatCount(controller.editor?.reviewItemCount ?? 0)}개</span>
                    <button
                      type="button"
                      className="un-btn is-text is-sm"
                      disabled={!model.canRollback || busy}
                      onClick={() => void controller.rollbackLatest()}
                    >
                      <RotateCcw size={14} />
                      바로 전 변경 되돌리기
                    </button>
                  </div>

                  <div className="un-cs-dock">
                    <span>{pending ?? '바꿀 곳을 골라 주세요'}</span>
                    {model.draftCommands.length > 0 && (
                      <button type="button" className="un-btn is-text is-sm" onClick={model.clearDraft}>
                        <Undo2 size={14} />
                        비우기
                      </button>
                    )}
                    <button
                      type="button"
                      className="un-btn is-primary is-sm"
                      disabled={busy || model.draftCommands.length === 0}
                      onClick={() => model.previewCommands(model.draftCommands)}
                    >
                      결과 보기
                    </button>
                  </div>
                </>
              )
            )}
          </section>
        </div>
      )}
    </div>,
    document.body,
  );
}
