import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import { SourceDownloadRecovery } from '../../features/external-sources/SourceDownloadRecovery';
import { importTaskIsActive, importTaskLabel, type ImportTaskView } from '../../features/import/import-task-projection';
import { cx, Sheet } from '../components/primitives';

function QueueGroup({ tasks, controller }: { tasks: ImportTaskView[]; controller: ExternalSourceController }) {
  const failed = tasks.filter((task) => task.phase === 'failed').length;
  const [expanded, setExpanded] = useState(failed > 0);
  const status =
    tasks.find((task) => importTaskIsActive(task) && task.phase !== 'queued') ??
    tasks.find((task) => task.phase === 'queued') ??
    tasks[0];
  return (
    <details className="un-queue-group" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>
          <b>{tasks[0].title}</b>
          <small className={cx(status.phase === 'failed' && 'is-failed')}>
            {tasks.length}개 · {importTaskLabel(status)}
            {failed > 0 && status.phase !== 'failed' && ` · 실패 ${failed}개`}
          </small>
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      {expanded && (
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <span>
                {task.fileName ?? task.title}
                <small className={cx(task.phase === 'failed' && 'is-failed')}>
                  {importTaskLabel(task)}
                  {task.error && ` · ${task.error}`}
                </small>
              </span>
              {task.phase === 'failed' && (
                <div className="un-queue-actions">
                  {!controller.busy && controller.canRetryTask(task.id) && (
                    <button
                      type="button"
                      className="un-btn is-sm is-ghost"
                      aria-label={`${task.fileName ?? task.title} 다시 시도`}
                      onClick={() => void controller.retryTask(task.id)}
                    >
                      다시 시도
                    </button>
                  )}
                  <button
                    type="button"
                    className="un-icon-btn"
                    aria-label={`${task.fileName ?? task.title} 오류 닫기`}
                    onClick={() => controller.dismissTask(task.id)}
                  >
                    <X size={18} />
                  </button>
                </div>
              )}
              {importTaskIsActive(task) && task.externalItemKey && (
                <button
                  type="button"
                  className="un-icon-btn"
                  aria-label={`${task.fileName ?? task.title} 다운로드 중단`}
                  disabled={task.finalizing || task.phase === 'cancelling'}
                  onClick={() => void controller.cancelTask(task)}
                >
                  <X size={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function SourceQueueSheet({ controller, onClose }: { controller: ExternalSourceController; onClose(): void }) {
  const batches = new Map<string, ImportTaskView[]>();
  for (const task of controller.tasks) {
    if (task.source !== 'external_source' || task.phase === 'complete') continue;
    const batch = batches.get(task.batchId);
    if (batch) batch.push(task);
    else batches.set(task.batchId, [task]);
  }
  return (
    <Sheet open title="다운로드 대기열" onClose={onClose}>
      {batches.size > 0 && (
        <div className="un-queue-groups">
          {Array.from(batches, ([id, tasks]) => (
            <QueueGroup key={id} tasks={tasks} controller={controller} />
          ))}
        </div>
      )}
      <SourceDownloadRecovery controller={controller} expanded />
      {!batches.size && !controller.recoverableDownloads?.length && (
        <p className="un-queue-empty" role="status">
          {controller.importBusy ? '다운로드를 준비하고 있어요.' : '대기 중인 다운로드가 없어요.'}
        </p>
      )}
    </Sheet>
  );
}
