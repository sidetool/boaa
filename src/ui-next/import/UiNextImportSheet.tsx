import { TEXT_ENCODING_LABELS } from '@boaa/text-core/parser';
import { BookOpen, FileArchive, FileText, ListTree, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import type { ChapterSplitMode, EncodingMode } from '../../domain/types';
import {
  formatImportBytes,
  formatImportChapterSplitMode,
  importProgressPercent,
} from '../../features/import/import-formatting';
import { projectImportProgress } from '../../features/import/import-task-projection';
import { LOCAL_IMPORT_TARGET_BYTES, type ImportFeatureController } from '../../features/import/useImportController';
import { formatCount, formatDateTime } from '../../utils/format';
import { cx, Progress, Sheet } from '../components/primitives';
import { Notice, Pref, PrefField, PrefFold, PrefGroup, PrefSection } from '../components/prefs';
import './import.css';

const ACCEPT =
  '.txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed';
const TEXT = /\.(txt|md|markdown)$/i;
const ARCHIVE = /\.(zip|cbz|rar|cbr|7z|cb7)$/i;
const NO_PREVIEW = /\.(epub|pdf|zip|cbz|rar|cbr|7z|cb7)$/i;
const DISPOSITION = { add: '추가', duplicate: '이미 있음', conflict: '기존 유지' } as const;

function fileIcon(name: string) {
  if (ARCHIVE.test(name)) return <FileArchive size={16} />;
  if (TEXT.test(name)) return <FileText size={16} />;
  return <BookOpen size={16} />;
}

/** 연재 묶음: what joins which work, and how many episodes are new, already there or kept as they are. */
function SeriesPlan({ controller }: { controller: ImportFeatureController }) {
  const comic = controller.seriesInspection;
  const document = controller.documentSeriesInspection;
  const inspection = comic ?? document;
  if (!inspection) return null;
  const plan = comic ? controller.seriesPlan : controller.documentSeriesPlan;
  const rows = comic
    ? (controller.seriesPlan?.releases ?? []).map((release) => ({
        key: `${release.id}:${release.originalName}`,
        title: release.parsed.releaseTitle,
        detail: `${release.pageCount}쪽`,
        state: release.disposition,
      }))
    : (controller.documentSeriesPlan?.chapters ?? []).map((chapter) => ({
        key: chapter.id,
        title: chapter.title,
        detail: `${formatCount(chapter.paragraphCount)}문단`,
        state: chapter.disposition,
      }));
  const limit = comic ? 8 : 12;
  return (
    <PrefSection
      title={comic ? '연재 작품으로 묶기' : '회차로 더하기'}
      hint={
        comic
          ? comic.sourceKind === 'nested_package'
            ? '압축 파일 안에서 회차를 찾았어요.'
            : '고른 압축 파일을 한 작품의 회차로 묶어요.'
          : '원본은 그대로 두고 새 회차만 작품에 더해요.'
      }
    >
      <div className="un-import-series">
        <strong>{inspection.workTitle}</strong>
        {!controller.seriesTargetLocked && inspection.candidateNovels.length > 0 && (
          <PrefField label="어디에 넣을까요">
            <select
              value={controller.seriesTargetNovelId ?? ''}
              disabled={controller.seriesBusy || controller.busy}
              onChange={(event) => void controller.setSeriesTargetNovel(event.target.value || undefined)}
            >
              <option value="">새 작품으로</option>
              {inspection.candidateNovels.map((novel) => (
                <option key={novel.id} value={novel.id}>
                  ‘{novel.title}’에 회차 더하기
                </option>
              ))}
            </select>
          </PrefField>
        )}
        {controller.seriesTargetLocked && plan?.targetNovel && (
          <p className="un-import-muted">‘{plan.targetNovel.title}’에 새 회차만 더해요.</p>
        )}
        {plan && (
          <>
            <div className="un-import-counts">
              <span className="is-add">새 회차 {plan.addCount}</span>
              <span>이미 있음 {plan.duplicateCount}</span>
              <span className={cx(plan.conflictCount > 0 && 'is-conflict')}>충돌 {plan.conflictCount}</span>
            </div>
            <ul className="un-import-rows">
              {rows.slice(0, limit).map((row) => (
                <li key={row.key} data-state={row.state}>
                  <span>{row.title}</span>
                  <small>{row.detail}</small>
                  <em>{DISPOSITION[row.state as keyof typeof DISPOSITION] ?? row.state}</em>
                </li>
              ))}
            </ul>
            {rows.length > limit && <p className="un-import-muted">외 {rows.length - limit}개 회차</p>}
            {plan.conflictCount > 0 && (
              <Notice tone="warning">
                {comic ? '번호는 같은데 내용이 다른 회차' : '제목은 같은데 본문이 다른 회차'}는 바꾸지 않고 기존 것을
                남겨요.
              </Notice>
            )}
          </>
        )}
      </div>
    </PrefSection>
  );
}

function SplitPreview({ controller }: { controller: ImportFeatureController }) {
  const preview = controller.preview;
  if (!preview) return null;
  const percent =
    preview.totalBytes === undefined ? 0 : importProgressPercent(preview.bytesRead ?? 0, preview.totalBytes);
  return (
    <PrefSection
      title="화 나눔 미리보기"
      action={
        <span className="un-import-muted">
          {preview.result
            ? `${formatCount(preview.result.totalChapters)}화`
            : preview.status === 'failed'
              ? '실패'
              : '계산 중'}
        </span>
      }
    >
      <div className="un-import-card">
        {preview.message && <p className="un-import-muted">{preview.message}</p>}
        {preview.status === 'loading' && preview.totalBytes !== undefined && (
          <>
            <Progress value={percent / 100} label="화 나눔 미리보기 진행률" />
            <small className="un-import-muted">
              {formatImportBytes(preview.bytesRead ?? 0)} / {formatImportBytes(preview.totalBytes)}
            </small>
          </>
        )}
        {preview.result && (
          <>
            <small className="un-import-muted">
              {preview.result.sourceEncoding.toUpperCase()} · {formatCount(preview.result.totalCharacters)}자 ·{' '}
              {formatCount(preview.result.totalParagraphs)}문단
            </small>
            <ul className="un-import-rows">
              {preview.result.chapters.slice(0, 8).map((chapter) => (
                <li key={`${chapter.index}:${chapter.title}`}>
                  <span>
                    <b>{chapter.index}</b> {chapter.title}
                  </span>
                  <small>{formatCount(chapter.paragraphCount)}문단</small>
                </li>
              ))}
            </ul>
            {preview.result.totalChapters > 8 && (
              <p className="un-import-muted">외 {formatCount(preview.result.totalChapters - 8)}화</p>
            )}
          </>
        )}
      </div>
    </PrefSection>
  );
}

function Running({ controller }: { controller: ImportFeatureController }) {
  const { batch, progress } = controller;
  if (!progress && !batch) return null;
  const percent = progress ? projectImportProgress(progress).percent : undefined;
  const title =
    progress?.status === 'ready'
      ? '다 가져왔어요'
      : progress?.status === 'failed'
        ? '가져오지 못했어요'
        : progress?.status === 'cancelling'
          ? '멈추는 중'
          : '가져오는 중';
  return (
    <div className={cx('un-import-card un-import-running', progress?.status && `is-${progress.status}`)}>
      <div className="un-import-running-head">
        <strong>{title}</strong>
        {percent !== undefined && <span>{Math.round(percent)}%</span>}
      </div>
      {batch && (
        <p className="un-import-muted">
          {batch.currentFileName ?? '기다리는 중'} · {formatCount(batch.current)}/{formatCount(batch.total)}
          {batch.failed > 0 ? ` · 실패 ${formatCount(batch.failed)}` : ''}
          {batch.skipped > 0 ? ` · 건너뜀 ${formatCount(batch.skipped)}` : ''}
        </p>
      )}
      {percent !== undefined && (
        <Progress
          value={percent / 100}
          label={progress?.subphase === 'server_processing' ? '파일 준비 진행률' : '가져오기 진행률'}
        />
      )}
      {progress?.message && <p className="un-import-muted">{progress.message}</p>}
      {progress && (
        <div className="un-import-stats">
          {progress.progressUnit === 'images' && progress.totalUnits !== undefined && (
            <span>
              이미지 {formatCount(progress.completedUnits ?? 0)}/{formatCount(progress.totalUnits)}
            </span>
          )}
          <span>
            {formatImportBytes(progress.bytesRead)} / {formatImportBytes(progress.totalBytes)}
          </span>
          <span>{formatCount(progress.chaptersDetected)}화</span>
          <span>{formatCount(progress.paragraphsWritten)}문단</span>
        </div>
      )}
      {controller.busy && (
        <button type="button" className="un-btn is-ghost is-sm" onClick={controller.cancelImport}>
          멈추기
        </button>
      )}
    </div>
  );
}

/** 책 가져오기: pick files, check how they join the library, then start. Imports keep running when closed. */
export function UiNextImportSheet({ controller }: { controller: ImportFeatureController }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const files = controller.pendingFiles;
  const picked = files.length > 0;
  const textChosen = !picked || files.some((file) => TEXT.test(file.name));
  const archiveChosen = files.some((file) => ARCHIVE.test(file.name));
  const pick = () => {
    if (controller.usesPlatformPicker) void controller.pickFiles();
    else input.current?.click();
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (controller.busy) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length) controller.selectFiles(dropped);
  };
  const series = controller.seriesPlan ?? controller.documentSeriesPlan;
  const startLabel = series?.targetNovel ? '새 회차 더하기' : series ? '연재 작품으로 가져오기' : '가져오기';
  const startBlocked =
    controller.busy ||
    controller.duplicateBusy ||
    controller.seriesBusy ||
    Boolean(controller.seriesInspection && !controller.seriesPlan) ||
    Boolean(controller.documentSeriesInspection && !controller.documentSeriesPlan);

  return (
    <Sheet
      open={controller.isOpen}
      onClose={controller.close}
      title={controller.seriesTargetLocked ? '회차 추가' : '책 가져오기'}
      footer={
        picked ? (
          <div className="un-import-foot">
            <button
              type="button"
              className="un-btn is-ghost"
              disabled={
                controller.busy || controller.preview?.status === 'loading' || NO_PREVIEW.test(files[0]?.name ?? '')
              }
              onClick={() => void controller.previewPendingImport()}
            >
              <ListTree size={16} />화 나눔 미리보기
            </button>
            <button
              type="button"
              className="un-btn is-primary"
              disabled={startBlocked}
              onClick={() => void controller.startPendingImport()}
            >
              <Upload size={16} />
              {startLabel}
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="un-import">
        {controller.appendTargetTitle && <Notice>‘{controller.appendTargetTitle}’에 차례로 더해요.</Notice>}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (chosen.length) controller.selectFiles(chosen);
          }}
        />

        <Running controller={controller} />

        <button
          type="button"
          className={cx('un-import-drop', picked && 'is-compact', dragging && 'is-over')}
          disabled={controller.busy}
          onClick={pick}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <span className="un-import-drop-icon" aria-hidden="true">
            <Upload size={picked ? 18 : 26} />
          </span>
          <span className="un-import-drop-text">
            <b>{picked ? '다른 파일로 바꾸기' : '파일 고르기'}</b>
            <small>
              {picked
                ? '새로 고르면 지금 목록을 바꿔요.'
                : `TXT · EPUB · PDF · 만화 압축(ZIP·CBZ·RAR·7z). 끌어다 놓아도 돼요.`}
            </small>
            {!picked && <small>텍스트는 {formatImportBytes(LOCAL_IMPORT_TARGET_BYTES)} 이하가 좋아요.</small>}
          </span>
        </button>

        {picked && (
          <PrefSection title={`고른 파일 ${formatCount(files.length)}개`}>
            <ul className="un-import-files">
              {files.slice(0, 4).map((file) => (
                <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                  {fileIcon(file.name)}
                  <span>{file.name}</span>
                  <small>{formatImportBytes(file.size)}</small>
                </li>
              ))}
            </ul>
            {files.length > 4 && (
              <p className="un-import-muted">외 {formatCount(files.length - 4)}개도 같은 설정으로 차례로 가져와요.</p>
            )}
            {archiveChosen &&
              (controller.supportsArchivePassword ? (
                <PrefGroup>
                  <PrefField label="압축 암호" help="가져오는 동안에만 쓰고 저장·동기화·백업하지 않아요.">
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="암호가 있을 때만"
                      value={controller.archivePassword}
                      disabled={controller.busy}
                      onChange={(event) => controller.setArchivePassword(event.target.value)}
                    />
                  </PrefField>
                </PrefGroup>
              ) : (
                <Notice>서버로 가져올 때는 암호 없는 압축 파일만 돼요.</Notice>
              ))}
            {controller.duplicateBusy && <p className="un-import-muted">서재에 이미 있는지 확인하는 중…</p>}
            {controller.seriesError && <Notice tone="danger">{controller.seriesError}</Notice>}
          </PrefSection>
        )}

        {picked && <SeriesPlan controller={controller} />}

        {picked && controller.duplicateConflicts.length > 0 && (
          <PrefSection title="이미 있는 작품" hint="파일마다 어떻게 할지 골라 주세요.">
            <PrefGroup>
              {controller.duplicateConflicts.map((conflict) => (
                <Pref
                  key={conflict.fileKey}
                  stacked
                  title={conflict.fileName}
                  help={
                    conflict.kind === 'same_source'
                      ? `같은 원본인 ‘${conflict.existingBook.title}’이 이미 있어요.`
                      : conflict.sourceHash
                        ? `이름이 같은 ‘${conflict.existingBook.title}’이 있지만 내용은 달라요.`
                        : `이름이 같은 ‘${conflict.existingBook.title}’이 이미 있어요.`
                  }
                  control={
                    <select
                      className="un-select"
                      aria-label={`${conflict.fileName} 처리`}
                      value={conflict.policy}
                      onChange={(event) =>
                        controller.setDuplicatePolicy(conflict.fileKey, event.target.value as typeof conflict.policy)
                      }
                    >
                      {conflict.kind === 'same_source' ? (
                        <>
                          <option value="open_existing">있는 책 열기</option>
                          <option value="skip">건너뛰기</option>
                          <option value="copy">따로 하나 더</option>
                        </>
                      ) : (
                        <>
                          <option value="new">새 책으로</option>
                          <option value="replace">있는 책 바꾸기</option>
                          <option value="skip">건너뛰기</option>
                        </>
                      )}
                    </select>
                  }
                />
              ))}
            </PrefGroup>
          </PrefSection>
        )}

        {textChosen && (
          <PrefFold
            title="텍스트 옵션"
            summary={`글자 인코딩 ${controller.encoding === 'auto' ? '자동' : TEXT_ENCODING_LABELS[controller.encoding]} · 화 나눔 ${
              controller.chapterSplitMode === 'auto'
                ? '자동'
                : formatImportChapterSplitMode(controller.chapterSplitMode)
            }`}
            defaultOpen={controller.encoding !== 'auto' || controller.chapterSplitMode !== 'auto'}
          >
            <PrefField label="글자 인코딩" help="글자가 깨지면 직접 골라 주세요.">
              <select
                value={controller.encoding}
                disabled={controller.busy}
                onChange={(event) => controller.setEncoding(event.target.value as EncodingMode)}
              >
                <option value="auto">자동</option>
                {Object.entries(TEXT_ENCODING_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </PrefField>
            <PrefField label="화 나누기" help="회차가 잘못 나뉘면 다른 방식을 골라 보세요.">
              <select
                value={controller.chapterSplitMode}
                disabled={controller.busy}
                onChange={(event) => controller.setChapterSplitMode(event.target.value as ChapterSplitMode)}
              >
                <option value="auto">자동</option>
                <option value="mixed">여러 표시 함께 찾기</option>
                <option value="single">나누지 않음</option>
              </select>
            </PrefField>
          </PrefFold>
        )}

        {picked && <SplitPreview controller={controller} />}

        {controller.uploadSessions.length > 0 && (
          <PrefSection title="멈춘 서버 업로드" hint="같은 파일을 다시 고르면 이어서 올려요.">
            <PrefGroup>
              {controller.uploadSessions.map((session) => (
                <Pref
                  key={session.key}
                  title={session.fileName}
                  help={`${formatImportBytes(session.sizeBytes)} · ${session.encoding.toUpperCase()} · ${formatImportChapterSplitMode(session.chapterSplitMode)} · ${formatDateTime(session.updatedAt)}`}
                  control={
                    <button
                      type="button"
                      className="un-icon-btn is-sm"
                      aria-label={`${session.fileName} 업로드 기록 지우기`}
                      disabled={controller.busy}
                      onClick={() => void controller.forgetUploadSession(session.key)}
                    >
                      <Trash2 size={15} />
                    </button>
                  }
                />
              ))}
            </PrefGroup>
          </PrefSection>
        )}
      </div>
    </Sheet>
  );
}

export default UiNextImportSheet;
