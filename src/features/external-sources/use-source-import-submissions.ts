import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { externalItemKeyId } from '../../external-sources/contracts';
import { sourceDownloadQueueId, type SourceDownloadQueue } from '../../external-sources/source-user-state';
import { randomUuid } from '../../utils/random-uuid';
import type { ImportTaskView } from '../import/import-task-projection';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './external-source-controller-contract';
import { isSerialSourceItem, serialCollectionKey } from './source-serial-item';

interface WaitingSourceImport {
  readonly id: string;
  readonly items: Map<string, ExternalSourceItemView>;
  readonly durable: Promise<unknown>;
  readonly queueId?: string;
  run(): Promise<void>;
}

export interface SourceImportSubmissions {
  running: boolean;
  startup?: AbortController;
  waiting: WaitingSourceImport[];
  starting?: WaitingSourceImport;
}

interface SubmissionPort {
  owner: UseExternalSourceControllerOptions;
  queue: SourceImportSubmissions;
  importBusy: boolean;
  blockingBusy: boolean;
  isMounted(): boolean;
  executing(): boolean;
  activeSeries():
    | {
        accepting: boolean;
        collectionKey: string;
        revisions: Map<string, string | undefined>;
        cancelledKeys: Set<string>;
      }
    | undefined;
  persistDownloadIntent(items: readonly ExternalSourceItemView[]): Promise<SourceDownloadQueue | undefined>;
  executeImportItems(
    items: readonly ExternalSourceItemView[],
    detached: boolean,
    silent: boolean,
    append?: boolean,
    startup?: AbortSignal,
  ): Promise<void>;
  activateQueue(id: string): void;
  clearActiveQueue(): void;
  refreshRecovery(): Promise<void>;
  setTasks: Dispatch<SetStateAction<ImportTaskView[]>>;
}

/** One writer drains accepted selections in FIFO order. Other works persist their intent while waiting. */
export function useSourceImportSubmissions(options: SubmissionPort) {
  const latest = useRef(options);
  latest.current = options;
  const { queue, importBusy, blockingBusy } = options;
  const [submissionVersion, wakeSubmissions] = useState(0);
  const importItems = useCallback(
    async (
      selected: readonly ExternalSourceItemView[],
      reportRejection = false,
      detached = false,
      silentSuccess = false,
    ) => {
      const port = latest.current;
      const owner = port.owner;
      const current = () =>
        latest.current.isMounted() &&
        owner.state === latest.current.owner.state &&
        owner.settingsScope === latest.current.owner.settingsScope;
      const first = selected[0];
      if (!first) return;
      const sourceId = first.key.connectorId as ExtensionContributionId;
      const connection = owner.registry.getExternalSourceStatus(sourceId, owner.hostContext);
      const connected = () => {
        const status = owner.registry.getExternalSourceStatus(sourceId, owner.hostContext);
        return (
          status.state === 'connected' &&
          status.accountConnectionId === first.key.accountConnectionId &&
          status.connectionGeneration === connection.connectionGeneration
        );
      };
      const handleError = (error: unknown) => {
        if (reportRejection) throw error;
        if (current())
          owner.notify(error instanceof Error ? error.message : '다운로드를 시작하지 못했습니다.', 'warning');
      };
      if (
        blockingBusy ||
        !connected() ||
        selected.some(
          (item) => item.key.connectorId !== sourceId || item.key.accountConnectionId !== first.key.accountConnectionId,
        )
      ) {
        handleError(new Error('소스 연결과 진행 중인 작업을 확인해 주세요.'));
        return;
      }

      const active = port.activeSeries();
      const alreadyQueued = (item: ExternalSourceItemView) => {
        const key = externalItemKeyId(item.key);
        return (
          active?.revisions.has(key) &&
          active.revisions.get(key) === item.remoteRevision &&
          !active.cancelledKeys.has(key)
        );
      };
      if (
        active?.accepting &&
        !queue.waiting.length &&
        selected.every((item) => !active.revisions.has(externalItemKeyId(item.key)) || alreadyQueued(item)) &&
        selected.every((item) => isSerialSourceItem(item) && serialCollectionKey(item) === active.collectionKey)
      ) {
        const additions = selected.filter((item) => !alreadyQueued(item));
        if (!additions.length) return;
        try {
          await port.persistDownloadIntent(additions);
          if (!current()) return;
          if (!connected()) throw new Error('대기 중 소스 연결이 변경되었습니다. 다시 연결해 주세요.');
          if (active === latest.current.activeSeries() && active.accepting) {
            await port.executeImportItems(additions, detached, silentSuccess, true);
            return;
          }
        } catch (error) {
          handleError(error);
          return;
        }
      }

      const waiting = Boolean(queue.running || latest.current.importBusy || port.executing() || queue.waiting.length);
      const accepted = new Map(
        selected.filter((item) => !alreadyQueued(item)).map((item) => [externalItemKeyId(item.key), item]),
      );
      for (const pending of queue.waiting) {
        for (const [key, item] of pending.items) {
          if (accepted.get(key)?.remoteRevision === item.remoteRevision) accepted.delete(key);
        }
      }
      if (!accepted.size) return;
      const id = `source-waiting-${randomUuid()}`;
      const durable = waiting ? port.persistDownloadIntent([...accepted.values()]) : Promise.resolve(undefined);
      const run = async () => {
        const startup = new AbortController();
        queue.startup = startup;
        const execute = async () => {
          if (!current() || !accepted.size) return;
          if (!connected()) throw new Error('대기 중 소스 연결이 변경되었습니다. 다시 연결해 주세요.');
          const intent = waiting ? await durable : await port.persistDownloadIntent([...accepted.values()]);
          if (!current() || !accepted.size) return;
          if (!connected()) throw new Error('대기 중 소스 연결이 변경되었습니다. 다시 연결해 주세요.');
          if (startup.signal.aborted) return;
          if (intent) port.activateQueue(intent.id);
          await port.executeImportItems(
            [...accepted.values()],
            detached || waiting,
            silentSuccess,
            false,
            startup.signal,
          );
        };
        try {
          if (first.collection && globalThis.navigator?.locks)
            await navigator.locks.request(
              `boaa-source-queue:${sourceDownloadQueueId(first.key, first.collection.remoteId)}`,
              { ifAvailable: true },
              async (lock) => {
                if (!lock) throw new Error('다른 탭에서 이 작품을 다운로드하고 있습니다.');
                await execute();
              },
            );
          else await execute();
        } catch (error) {
          if (waiting) {
            if (current())
              owner.notify(error instanceof Error ? error.message : '다운로드를 시작하지 못했습니다.', 'warning');
          } else handleError(error);
        } finally {
          queue.startup = undefined;
          if (current()) {
            port.clearActiveQueue();
            port.setTasks((tasks) => tasks.filter((task) => task.batchId !== id));
            await port.refreshRecovery().catch(() => undefined);
          }
        }
      };
      if (waiting) {
        const job: WaitingSourceImport = {
          id,
          items: accepted,
          durable,
          run,
          queueId: first.collection && sourceDownloadQueueId(first.key, first.collection.remoteId),
        };
        queue.waiting.push(job);
        port.setTasks((tasks) => [
          ...tasks,
          ...[...accepted].map(([key, item], index): ImportTaskView => ({
            id: `${id}-${index}`,
            batchId: id,
            source: 'external_source',
            title: item.collection?.title ?? item.title,
            fileName: item.release?.title ?? item.title,
            externalItemKey: key,
            phase: 'queued',
            current: index + 1,
            total: accepted.size,
          })),
        ]);
        try {
          await durable;
        } catch (error) {
          queue.waiting = queue.waiting.filter((entry) => entry !== job);
          if (current()) port.setTasks((tasks) => tasks.filter((task) => task.batchId !== id));
          handleError(error);
        }
        wakeSubmissions((v) => v + 1);
        return;
      }
      queue.running = true;
      try {
        await run();
      } finally {
        queue.running = false;
        if (latest.current.isMounted()) wakeSubmissions((v) => v + 1);
      }
    },
    [queue, blockingBusy],
  );

  useEffect(() => {
    if (queue.running || importBusy || blockingBusy || latest.current.executing()) return;
    const next = queue.waiting.shift();
    if (!next) return;
    queue.running = true;
    queue.starting = next;
    void next.run().finally(() => {
      queue.starting = undefined;
      queue.running = false;
      if (latest.current.isMounted()) wakeSubmissions((v) => v + 1);
    });
  }, [queue, importBusy, blockingBusy, submissionVersion]);

  return importItems;
}
