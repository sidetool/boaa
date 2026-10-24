import type { CSSProperties } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
} from '../../features/external-sources/external-source-controller-contract';
import type { SourceHubAction, sourceHubItemActions } from '../../features/external-sources/source-hub-item-actions';
import {
  canSelectItem,
  itemDescription,
  itemStateLabel,
  updatedLabel,
} from '../../features/external-sources/source-hub-item-model';
import {
  importTaskDetail,
  importTaskIsActive,
  importTaskStageLabel,
  type ImportTaskView,
} from '../../features/import/import-task-projection';
import { formatBytes } from '../../utils/format';
import { cx, Progress } from '../components/primitives';

/** A file row follows its own import task: queued → transfer/processing → done, or failed with a retry.
 * Transfers without a known size stay indeterminate rather than showing a made-up percentage. */
export function SourceFileRow({
  item,
  controller,
  actions,
  task,
}: {
  item: ExternalSourceItemView;
  controller: ExternalSourceController;
  actions: ReturnType<typeof sourceHubItemActions>;
  task?: ImportTaskView;
}) {
  const selectable = canSelectItem(item);
  const supported = selectable || item.importState === 'imported';
  const active = Boolean(task && importTaskIsActive(task));
  const failed = task?.phase === 'failed';
  // The list refresh that marks the file imported can land a moment after the task completes.
  const done = task?.phase === 'complete' && !actions.canRead;
  // A failed update of a saved file retries through the same import (and its update confirmation).
  const retry = failed && selectable;
  const opens = actions.canRead && !retry;
  const primary: SourceHubAction | undefined = opens
    ? actions.read
    : item.importState === 'imported' || !selectable || done
      ? undefined
      : actions.import;
  const primaryLabel = opens
    ? '열기'
    : retry
      ? '다시 시도'
      : item.importState === 'update_available'
        ? '업데이트'
        : '가져오기';
  return (
    <div
      className={cx('un-source-file', item.selected && 'is-selected', active && 'is-active', failed && 'is-failed')}
      aria-busy={active || undefined}
    >
      {selectable ? (
        <label className="un-release-check">
          <input
            type="checkbox"
            checked={item.selected}
            disabled={controller.busy}
            aria-label={`${item.title} 선택`}
            onChange={actions.toggleSelection}
          />
          <span aria-hidden="true">{item.selected && <Check size={14} strokeWidth={3} />}</span>
        </label>
      ) : (
        <span className="un-release-check" aria-hidden="true" />
      )}
      <span className="un-source-file-icon" aria-hidden="true">
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <FileText size={20} />}
      </span>
      <span className="un-source-file-text">
        <b title={item.title}>{item.title}</b>
        <small>
          {[
            itemDescription(item),
            item.formatHint,
            item.byteLength !== undefined ? formatBytes(item.byteLength) : undefined,
            updatedLabel(item.updatedAt),
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
        {item.localBookTitle && <small>서재: {item.localBookTitle}</small>}
        {task && (active || failed || done) ? (
          <FileTaskState item={item} task={task} />
        ) : (
          <span className={cx('un-release-state', `is-${supported ? item.importState : 'unsupported'}`)}>
            {item.importState === 'imported' && <Check size={12} />}
            {supported ? itemStateLabel(item) : '지원하지 않음'}
          </span>
        )}
      </span>
      {active && task ? (
        <button
          type="button"
          className="un-btn is-sm is-ghost un-source-file-action is-progress"
          disabled={task.phase === 'cancelling'}
          aria-label={`${item.title} ${task.phase === 'cancelling' ? '취소 중' : '가져오기 중단'}`}
          onClick={controller.cancel}
        >
          <span
            className={cx('un-source-file-ring', task.percent === undefined && 'is-indeterminate')}
            style={{ '--un-ring': `${task.percent ?? 28}%` } as CSSProperties}
            aria-hidden="true"
          >
            <X size={11} strokeWidth={3} />
          </span>
          <span className="un-source-file-action-label">{task.phase === 'cancelling' ? '취소 중' : '중단'}</span>
        </button>
      ) : (
        primary && (
          <button
            type="button"
            className={cx('un-btn is-sm un-source-file-action', opens ? 'is-ghost' : 'is-primary')}
            disabled={primary.disabled}
            onClick={() => void primary.run()}
          >
            {opens ? (
              <BookOpen size={15} />
            ) : retry ? (
              <RotateCcw size={15} />
            ) : item.importState === 'update_available' ? (
              <RefreshCw size={15} />
            ) : (
              <Download size={15} />
            )}
            <span className="un-source-file-action-label">{primaryLabel}</span>
          </button>
        )
      )}
      {controller.canRemoveItems && (
        <button
          type="button"
          className="un-icon-btn is-sm"
          disabled={controller.busy}
          aria-label={`${item.title} 선택 목록에서 제거`}
          onClick={() => void actions.remove()}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function FileTaskState({ item, task }: { item: ExternalSourceItemView; task: ImportTaskView }) {
  if (task.phase === 'complete')
    return (
      <span className="un-release-state is-imported" role="status">
        <Check size={12} />
        가져오기 완료
      </span>
    );
  if (task.phase === 'failed')
    return (
      <>
        <span className="un-release-state is-failed" role="alert">
          <AlertTriangle size={12} />
          가져오지 못했어요
        </span>
        {task.error && <small className="un-source-file-error">{task.error}</small>}
      </>
    );
  const detail = [task.percent !== undefined ? `${task.percent}%` : undefined, importTaskDetail(task)]
    .filter(Boolean)
    .join(' · ');
  const stage = importTaskStageLabel(task);
  return (
    <>
      <span className={cx('un-release-state is-active', task.phase === 'queued' && 'is-queued')}>
        {task.phase !== 'queued' && <LoaderCircle size={12} className="un-spin" />}
        {/* Only the stage is live; percentages would be re-announced on every tick. */}
        <span role="status">{stage}</span>
        {detail && <span className="un-source-file-detail">· {detail}</span>}
      </span>
      {task.phase !== 'queued' &&
        (task.percent === undefined ? (
          <span
            className="un-progress un-source-file-progress is-indeterminate"
            role="progressbar"
            aria-label={`${item.title} ${stage}`}
          >
            <span />
          </span>
        ) : (
          <Progress value={task.percent / 100} label={`${item.title} ${stage}`} className="un-source-file-progress" />
        ))}
    </>
  );
}
