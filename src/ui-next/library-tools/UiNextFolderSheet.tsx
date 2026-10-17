import {
  AlertTriangle,
  Check,
  FileArchive,
  FileText,
  FolderOpen,
  FolderPlus,
  Link2,
  RefreshCw,
  Unlink,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import type { LibraryFolderCandidateStatus } from '../../library-folders/contracts';
import { createLibraryFolderPanelModel, isActionable } from '../../features/library-folders/library-folder-panel-model';
import type { LibraryFolderController } from '../../features/library-folders/useLibraryFolderController';
import { formatBytes, formatCount } from '../../utils/format';
import { ConfirmSheet } from '../components/dialogs';
import { cx, Progress, Sheet } from '../components/primitives';
import { EmptyState, Notice, PrefField, PrefFold, PrefGroup, PrefSwitch } from '../components/prefs';
import './library-tools.css';

const FORMAT = {
  text: 'TXT',
  epub: 'EPUB',
  pdf: 'PDF',
  zip: 'ZIP·CBZ',
  rar: 'RAR·CBR',
  '7z': '7z·CB7',
} as const;

const STATUS: Record<LibraryFolderCandidateStatus, string> = {
  new: '새 책',
  changed: '원본 바뀜',
  'update-existing': '있는 책에 연결',
  unchanged: '최신',
  missing: '원본 없음',
  failed: '확인 실패',
  'below-minimum': '너무 작음',
  'above-maximum': '너무 큼',
  unsupported: '지원 안 함',
} as Record<LibraryFolderCandidateStatus, string>;

function tone(status: LibraryFolderCandidateStatus) {
  if (status === 'new') return 'is-new';
  if (status === 'changed' || status === 'update-existing') return 'is-changed';
  if (status === 'missing' || status === 'failed') return 'is-missing';
  return '';
}

const megabytes = (value: number | undefined) =>
  value === undefined ? '' : String(Math.round((value / (1024 * 1024)) * 100) / 100);

/** 폴더 연결: watch folders, pick which files come in, and import new or changed ones together. */
export default function UiNextFolderSheet({ controller }: { controller: LibraryFolderController }) {
  const model = createLibraryFolderPanelModel(controller);
  const { folder } = model;
  const [unlinking, setUnlinking] = useState(false);
  const busy = controller.busy;
  const allPicked = model.actionable.length > 0 && model.selectedCount === model.actionable.length;

  return (
    <Sheet
      open={controller.open}
      onClose={controller.close}
      closeDisabled={busy}
      title="폴더 연결"
      footer={
        folder ? (
          busy ? (
            <button type="button" className="un-btn is-ghost un-tools-wide" onClick={controller.cancel}>
              멈추기
            </button>
          ) : (
            <button
              type="button"
              className="un-btn is-primary un-tools-wide"
              disabled={model.selectedCount === 0 || controller.scanning}
              onClick={() => void controller.importSelected()}
            >
              <Upload size={16} />
              {model.selectedCount ? `${formatCount(model.selectedCount)}개 가져오기` : '가져올 변경 없음'}
            </button>
          )
        ) : undefined
      }
    >
      <div className="un-tools">
        {controller.folders.length > 0 && (
          <div className="un-folder-chips" role="tablist" aria-label="연결한 폴더">
            {controller.folders.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === folder?.id}
                className={cx('un-chip', item.id === folder?.id && 'is-active')}
                onClick={() => void controller.selectFolder(item.id)}
              >
                <FolderOpen size={14} />
                {item.displayName}
                {item.lastError && <AlertTriangle size={13} aria-label="확인 필요" />}
              </button>
            ))}
            <button
              type="button"
              className="un-chip"
              disabled={!controller.available || busy}
              onClick={() => void controller.pickFolder()}
            >
              <FolderPlus size={14} />
              폴더 추가
            </button>
          </div>
        )}

        {!controller.available && controller.folders.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={22} />}
            title="여기서는 폴더를 계속 연결할 수 없어요"
            body="파일 가져오기는 그대로 쓸 수 있어요."
          />
        ) : !folder ? (
          <EmptyState
            icon={<FolderOpen size={22} />}
            title="책이 있는 폴더를 연결해 보세요"
            body="형식과 크기를 고른 뒤, 고른 파일만 한 번에 가져와요."
            action={
              <button type="button" className="un-btn is-primary" onClick={() => void controller.pickFolder()}>
                <FolderOpen size={16} />
                폴더 고르기
              </button>
            }
          />
        ) : (
          <>
            <div className="un-tools-card un-folder-head">
              <div>
                <strong>{folder.displayName}</strong>
                <small>
                  {folder.lastScanAt ? `마지막 확인 ${new Date(folder.lastScanAt).toLocaleString()}` : '아직 확인 전'}
                </small>
              </div>
              <button
                type="button"
                className="un-icon-btn is-sm"
                aria-label="다시 확인"
                disabled={busy || controller.scanning}
                onClick={() => void controller.scanActiveFolder()}
              >
                <RefreshCw size={16} className={controller.scanning ? 'un-spin' : undefined} />
              </button>
              <button
                type="button"
                className="un-icon-btn is-sm"
                aria-label="폴더 연결 끊기"
                disabled={busy}
                onClick={() => setUnlinking(true)}
              >
                <Unlink size={16} />
              </button>
            </div>

            <PrefGroup>
              <PrefSwitch
                title="바뀌면 자동으로 반영"
                checked={folder.autoSync}
                disabled={busy}
                onChange={(on) => void controller.setAutoSync(on)}
              />
            </PrefGroup>

            <PrefFold
              title="가져올 파일"
              summary={`${folder.filter.formats.map((format) => FORMAT[format]).join(', ') || '형식 없음'}${folder.filter.recursive ? ' · 하위 폴더 포함' : ''}`}
            >
              <div className="un-pref is-stacked">
                <div className="un-pref-text">
                  <strong>형식</strong>
                </div>
                <div className="un-pref-chips" role="group" aria-label="가져올 형식">
                  {model.formats.map((format) => {
                    const on = folder.filter.formats.includes(format);
                    return (
                      <button
                        key={format}
                        type="button"
                        aria-pressed={on}
                        disabled={busy}
                        className={cx('un-chip', on && 'is-active')}
                        onClick={() => void model.setFormat(format, !on)}
                      >
                        {FORMAT[format]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="un-folder-size">
                <PrefField label="최소 크기 (MB)">
                  <input
                    key={`${folder.id}-min-${folder.filter.minBytes}`}
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="제한 없음"
                    defaultValue={megabytes(folder.filter.minBytes)}
                    disabled={busy}
                    onBlur={(event) => void model.setSize('minBytes', event.target.value)}
                  />
                </PrefField>
                <PrefField label="최대 크기 (MB)">
                  <input
                    key={`${folder.id}-max-${folder.filter.maxBytes}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="제한 없음"
                    defaultValue={megabytes(folder.filter.maxBytes)}
                    disabled={busy}
                    onBlur={(event) => void model.setSize('maxBytes', event.target.value)}
                  />
                </PrefField>
              </div>
              <PrefSwitch
                title="하위 폴더도 보기"
                checked={folder.filter.recursive}
                disabled={busy}
                onChange={(on) => void controller.updateFilter({ recursive: on })}
              />
            </PrefFold>

            {folder.lastError && <Notice tone="danger">{folder.lastError}</Notice>}

            <div className="un-folder-list-head">
              <label className={cx('un-folder-check', allPicked && 'is-checked')}>
                <input
                  type="checkbox"
                  checked={allPicked}
                  disabled={model.actionable.length === 0 || busy}
                  onChange={(event) => controller.selectAllActionable(event.target.checked)}
                />
                <span className="un-storage-check" aria-hidden="true" />
                파일 {formatCount(controller.candidates.length)}개
              </label>
              <small>{model.selectedCount ? `${formatCount(model.selectedCount)}개 고름` : '가져올 변경 없음'}</small>
            </div>

            {controller.scanning && controller.candidates.length === 0 ? (
              <p className="un-tools-note" role="status">
                폴더를 확인하는 중…
              </p>
            ) : controller.candidates.length === 0 ? (
              <EmptyState title="조건에 맞는 파일이 없어요" />
            ) : (
              <ul className="un-folder-files">
                {controller.candidates.map((candidate) => {
                  const actionable = isActionable(candidate.status);
                  return (
                    <li key={candidate.id}>
                      <label className={cx(candidate.selected && 'is-checked', !actionable && 'is-idle')}>
                        <input
                          type="checkbox"
                          checked={candidate.selected}
                          disabled={!actionable || busy}
                          onChange={() => controller.toggleCandidate(candidate.id)}
                        />
                        <span className="un-storage-check" aria-hidden="true" />
                        <span className="un-folder-icon" aria-hidden="true">
                          {candidate.format === 'text' || candidate.format === 'epub' || candidate.format === 'pdf' ? (
                            <FileText size={16} />
                          ) : (
                            <FileArchive size={16} />
                          )}
                        </span>
                        <span className="un-folder-name">
                          <strong>{candidate.fileName}</strong>
                          <small>
                            {formatBytes(candidate.byteLength)} · {candidate.relativePath}
                          </small>
                          {candidate.existingBookTitle && <em>‘{candidate.existingBookTitle}’에 연결</em>}
                          {candidate.readError && <em>{candidate.readError}</em>}
                        </span>
                        <span className={cx('un-folder-status', tone(candidate.status))}>
                          {candidate.status === 'unchanged' && <Check size={12} />}
                          {candidate.status === 'update-existing' && <Link2 size={12} />}
                          {STATUS[candidate.status] ?? '지원 안 함'}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}

            {controller.progress && (
              <div className="un-tools-card is-running" role="status" aria-live="polite">
                <div className="un-tools-running-head">
                  <strong>{controller.progress.fileName ?? '폴더 가져오기'}</strong>
                  <span>
                    {controller.progress.current}/{controller.progress.total}
                  </span>
                </div>
                <Progress
                  value={
                    (controller.progress.completed + controller.progress.linkedExisting) /
                    Math.max(1, controller.progress.total)
                  }
                />
                {controller.progress.detail?.message && <small>{controller.progress.detail.message}</small>}
              </div>
            )}
            <p className="un-tools-note">원본이 지워져도 서재에서 지우지 않고 ‘원본 없음’으로만 표시해요.</p>
          </>
        )}
      </div>
      <ConfirmSheet
        open={unlinking}
        title="폴더 연결을 끊을까요?"
        confirmLabel="연결 끊기"
        danger
        onConfirm={() => void model.remove(() => true)}
        onClose={() => setUnlinking(false)}
      >
        <p>연결만 끊어요. 이미 가져온 책은 서재에 그대로 있어요.</p>
      </ConfirmSheet>
    </Sheet>
  );
}
