import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { Chapter } from '../../domain/types';
import {
  externalItemKeyId,
  type ExternalItemSummary,
  type TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import { sourceDownloadQueueId, type SourceDownloadQueue } from '../../external-sources/source-user-state';
import type { ToastTone } from '../../shared/ui/ToastHost';
import { completeSeriesCatalog } from './complete-series-catalog';
import { filterAndSortReleases } from './source-release-list-model';
import { externalItemSectionId, externalReleaseRevisionChanged } from './serial-work-projection';
import { isSerialSourceItem, serialCollectionKey, type SerialSourceItem } from './source-serial-item';
import {
  loadSourceLibrary,
  type SourceLibrarySnapshot,
  type SourceLibrarySnapshotPort,
} from './source-library-snapshot';
import type { ExternalSourceItemView } from './external-source-controller-contract';

interface SourceDownloadRecoveryPort extends SourceLibrarySnapshotPort {
  readonly registry: Pick<ExternalSourceRegistryPort, 'getExternalSourceStatus' | 'listExternalSource'>;
  readonly hostContext: TrustedExternalSourceHostContext;
  readonly initializeRecovery?: boolean;
  listChapters(bookId: string): Promise<Chapter[]>;
  notify(message: string, tone?: ToastTone): void;
  isMounted(): boolean;
  isBusy(): boolean;
  scheduledQueueIds?(): string[];
  setImportBusy(value: boolean): void;
  setDownloadAbort(value: AbortController | undefined): void;
  importSerialItems(
    sourceId: ExtensionContributionId,
    items: SerialSourceItem[],
    startup: AbortSignal,
  ): Promise<boolean>;
}

const currentIso = () => new Date().toISOString();

/** Owns persisted queue intent and recovery. Execution and user cancellation stay with the import session. */
export function useSourceDownloadRecovery(port: SourceDownloadRecoveryPort) {
  const portRef = useRef(port);
  portRef.current = port;
  const activeQueueIdRef = useRef<string>();
  const activeState = useRef(port.state);
  const checkpointDownloadQueue = useCallback(
    async (completed: readonly ExternalItemSummary[], id = activeQueueIdRef.current, state = activeState.current) => {
      if (!id) return;
      const items = completed.map((item) => ({
        key: item.key,
        remoteRevision: item.remoteRevision,
        title: item.title,
        sectionId: externalItemSectionId(item),
      }));
      if (state.checkpointDownloadItems) await state.checkpointDownloadItems(id, items);
      else await state.pruneDownloadQueue?.(id, items);
    },
    [],
  );
  const [recoverableDownloads, setRecoverableDownloads] = useState<readonly SourceDownloadQueue[]>([]);
  const recoveryBusyRef = useRef(false);

  useEffect(() => {
    activeQueueIdRef.current = undefined;
    activeState.current = port.state;
    setRecoverableDownloads([]);
  }, [port.state, port.settingsScope]);

  const recoveryGeneration = useRef(0);
  const reconcileDownloadQueue = useCallback(
    async (
      queue: SourceDownloadQueue,
      port: SourceDownloadRecoveryPort = portRef.current,
      snapshot?: SourceLibrarySnapshot,
      chapterReads = new Map<string, Promise<Set<string>>>(),
      isCurrent: () => boolean = () => true,
    ) => {
      const current = () =>
        isCurrent() && portRef.current.state === port.state && portRef.current.settingsScope === port.settingsScope;
      const library = snapshot ?? (await loadSourceLibrary(port));
      const linksByKey = new Map(
        library.links.filter((link) => !link.pendingImport).map((link) => [externalItemKeyId(link.source), link]),
      );
      const bookIds = new Set(
        queue.items
          .map((item) => linksByKey.get(externalItemKeyId(item.key))?.localBookId)
          .filter((id): id is string => Boolean(id)),
      );
      const sections = new Map(
        await Promise.all(
          [...bookIds].map(async (id) => {
            let chapters = chapterReads.get(id);
            if (!chapters) {
              chapters = port
                .listChapters(id)
                .then((rows) => new Set(rows.map((chapter) => chapter.documentSectionId ?? chapter.id)));
              chapterReads.set(id, chapters);
            }
            return [id, await chapters] as const;
          }),
        ),
      );
      const activeBooks = new Set(library.novels.filter((book) => !book.deletedAt).map((book) => book.id));
      const remaining = queue.items.filter((item) => {
        const link = linksByKey.get(externalItemKeyId(item.key));
        return (
          !link ||
          !activeBooks.has(link.localBookId) ||
          !sections.get(link.localBookId)?.has(item.sectionId) ||
          (item.remoteRevision !== undefined &&
            externalReleaseRevisionChanged(
              { key: item.key, remoteRevision: item.remoteRevision },
              link.importedRemoteRevision,
            ))
        );
      });
      if (!current()) return queue;
      const next = { ...queue, items: remaining, updatedAt: currentIso() };
      if (port.state.pruneDownloadQueue) {
        const kept = new Set(remaining.map((item) => externalItemKeyId(item.key)));
        return (
          (await port.state.pruneDownloadQueue(
            queue.id,
            queue.items.filter((item) => !kept.has(externalItemKeyId(item.key))),
          )) ?? { ...next, items: [] }
        );
      }
      if (!remaining.length) await port.state.deleteDownloadQueue?.(queue.id);
      return next;
    },
    [],
  );

  const refreshRecovery = useCallback(
    async (reconcile = false, snapshot?: SourceLibrarySnapshot) => {
      const port = portRef.current;
      const generation = ++recoveryGeneration.current;
      const current = () =>
        portRef.current.state === port.state &&
        portRef.current.settingsScope === port.settingsScope &&
        generation === recoveryGeneration.current;
      const exclude = new Set(port.scheduledQueueIds?.());
      if (activeQueueIdRef.current) exclude.add(activeQueueIdRef.current);
      const queues = ((await port.state.listDownloadQueues?.(exclude)) ?? []).filter((queue) => !exclude.has(queue.id));
      const library = reconcile && queues.length ? (snapshot ?? (await loadSourceLibrary(port))) : undefined;
      const chapters = new Map<string, Promise<Set<string>>>();
      const pending: SourceDownloadQueue[] = [];
      for (const queue of queues) {
        if (!current()) return;
        if (queue.id === activeQueueIdRef.current) continue;
        const next = reconcile ? await reconcileDownloadQueue(queue, port, library, chapters, current) : queue;
        if (next.items.length) pending.push(next);
      }
      if (current() && port.isMounted()) setRecoverableDownloads(pending);
    },
    [reconcileDownloadQueue],
  );
  useEffect(() => {
    if (port.initializeRecovery !== false) void refreshRecovery(true).catch(() => undefined);
  }, [refreshRecovery, port.state, port.settingsScope, port.initializeRecovery]);

  const persistDownloadIntent = useCallback(async (selected: readonly ExternalSourceItemView[]) => {
    const serial = selected.filter((item): item is SerialSourceItem => isSerialSourceItem(item));
    if (!serial.length || serial.length !== selected.length || !portRef.current.state.saveDownloadQueue)
      return undefined;
    const first = serial[0]!;
    if (!serial.every((item) => serialCollectionKey(item) === serialCollectionKey(first))) return undefined;
    const id = sourceDownloadQueueId(first.key, first.collection.remoteId);
    const pending = filterAndSortReleases(serial, '', 'all', 'asc').map((item) => ({
      key: item.key,
      title: item.originalTitle ?? item.title,
      remoteRevision: item.remoteRevision,
      sectionId: externalItemSectionId(item),
    }));
    const queue: SourceDownloadQueue = {
      id,
      kind: 'downloadQueue',
      connectorId: first.key.connectorId,
      accountConnectionId: first.key.accountConnectionId,
      collectionRemoteId: first.collection.remoteId,
      title: first.collection.title,
      updatedAt: currentIso(),
      items: pending,
    };
    await portRef.current.state.saveDownloadQueue(queue);
    return queue;
  }, []);

  const resumeDownloadQueue = useCallback(
    async (queue: SourceDownloadQueue) => {
      if (portRef.current.isBusy() || recoveryBusyRef.current) return;
      recoveryBusyRef.current = true;
      activeQueueIdRef.current = queue.id;
      const owner = portRef.current;
      activeState.current = owner.state;
      const currentOwner = () =>
        portRef.current.state === owner.state &&
        portRef.current.settingsScope === owner.settingsScope &&
        owner.isMounted();
      const abort = new AbortController();
      owner.setDownloadAbort(abort);
      owner.setImportBusy(true);
      try {
        const run = async () => {
          if (!currentOwner() || abort.signal.aborted) return;
          const remaining = await reconcileDownloadQueue(queue, owner, undefined, undefined, currentOwner);
          if (!currentOwner() || abort.signal.aborted || !remaining.items.length) return;
          const sourceId = queue.connectorId as ExtensionContributionId;
          const registry = owner.registry;
          const context = owner.hostContext;
          const connection = registry.getExternalSourceStatus(sourceId, context);
          if (connection.state !== 'connected' || connection.accountConnectionId !== queue.accountConnectionId)
            throw new Error('이 대기열을 만든 소스 계정으로 다시 연결해 주세요.');
          const read = (cursor?: string) =>
            registry.listExternalSource(
              sourceId,
              context,
              { parentRef: queue.collectionRemoteId, cursor, cacheMode: cursor ? undefined : 'reload' },
              abort.signal,
            );
          const requested = new Map(remaining.items.map((item) => [externalItemKeyId(item.key), item]));
          const page = await completeSeriesCatalog(await read(), read, abort.signal, new Set(requested.keys()));
          const current = registry.getExternalSourceStatus(sourceId, context);
          if (
            owner.state !== portRef.current.state ||
            owner.settingsScope !== portRef.current.settingsScope ||
            current.state !== 'connected' ||
            current.accountConnectionId !== connection.accountConnectionId ||
            current.connectionGeneration !== connection.connectionGeneration
          )
            throw new Error('소스 연결이 변경되어 이어받기를 중단했습니다.');
          abort.signal.throwIfAborted();
          const matching = new Map(page.items.map((item) => [externalItemKeyId(item.key), item]));
          const selected = [...requested].flatMap(([key, intent]) => {
            const item = matching.get(key);
            if (
              !item ||
              !isSerialSourceItem(item) ||
              item.collection.remoteId !== queue.collectionRemoteId ||
              externalItemSectionId(item) !== intent.sectionId ||
              (intent.remoteRevision !== undefined && item.remoteRevision !== intent.remoteRevision)
            )
              return [];
            return [{ ...item, selected: false, importState: 'available' as const }];
          });
          if (selected.length !== remaining.items.length)
            owner.notify(
              `사라지거나 변경된 ${remaining.items.length - selected.length}개 회차는 대기열에 남겼습니다. 회차 목록에서 확인해 주세요.`,
              'warning',
            );
          if (!selected.length) return;
          await owner.importSerialItems(sourceId, selected, abort.signal);
          if (currentOwner()) await reconcileDownloadQueue(remaining, owner, undefined, undefined, currentOwner);
        };
        if (globalThis.navigator?.locks)
          await navigator.locks.request(`boaa-source-queue:${queue.id}`, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error('다른 탭에서 이 대기열을 처리하고 있습니다.');
            await run();
          });
        else await run();
      } catch (error) {
        if (currentOwner())
          owner.notify(
            error instanceof Error ? error.message : '이어받기에 실패했습니다. 다시 시도할 수 있습니다.',
            'warning',
          );
      } finally {
        if (currentOwner()) owner.setDownloadAbort(undefined);
        activeQueueIdRef.current = undefined;
        recoveryBusyRef.current = false;
        if (owner.isMounted()) owner.setImportBusy(false);
        await refreshRecovery();
      }
    },
    [reconcileDownloadQueue, refreshRecovery],
  );

  const discardDownloadQueue = useCallback(
    async (id: string) => {
      if (portRef.current.isBusy() || recoveryBusyRef.current) return;
      try {
        await portRef.current.state.deleteDownloadQueue?.(id);
        await refreshRecovery();
      } catch {
        portRef.current.notify('대기열을 제거하지 못했습니다. 다시 시도해 주세요.', 'warning');
      }
    },
    [refreshRecovery],
  );

  const isRecovering = useCallback(() => recoveryBusyRef.current, []);
  const activateQueue = useCallback((id: string) => {
    activeQueueIdRef.current = id;
    activeState.current = portRef.current.state;
  }, []);
  const clearActiveQueue = useCallback(() => {
    activeQueueIdRef.current = undefined;
  }, []);
  return {
    recoverableDownloads,
    checkpointDownloadQueue,
    refreshRecovery,
    persistDownloadIntent,
    resumeDownloadQueue,
    discardDownloadQueue,
    isRecovering,
    activateQueue,
    clearActiveQueue,
  };
}
