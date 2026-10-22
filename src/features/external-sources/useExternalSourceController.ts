import { sourceReadingPreferences } from '../../external-sources/source-reading-preferences';
import { createLibraryCoverResolver } from './library-cover-resolver';
import { isTextStream } from '../../external-sources/source-text-stream';
import { useSourceWorkMetadata } from './use-source-work-metadata';
import { useStreamLibraryContinuity } from './use-stream-library-continuity';
import { useSourceLibraryReader } from './use-source-library-reader';

import {
  sourceReadMode as baseSourceReadMode,
  isTextSourceItem,
  preferTextLibrary as basePreferTextLibrary,
} from './source-read-mode';
import { useSourceLibraryOpen } from './use-source-library-open';
import { useSourceStreamSession } from './use-source-stream-session';
import { useSourceCatalogQuery, type SourceCatalogQueryIntent } from './use-source-catalog-query';
import { defaultFilterValues } from './source-catalog-query-values';
import { useSourceSubscriptionRefresh } from './use-source-subscription-refresh';
import { persistentThumbnailUrl } from './source-persistent-thumbnail';
import { useSourceLibraryLinks } from './use-source-library-links';
import { useSourceDownloadRecovery } from './use-source-download-recovery';
import { isSerialSourceItem, serialCollectionKey, type SerialSourceItem } from './source-serial-item';
import { loadSourceLibrary } from './source-library-snapshot';
import { updateSourceLibraryMetadata } from './source-library-metadata';
import { useSourceReaderCatalog } from './use-source-reader-catalog';
import { sourceLibraryLoad } from './source-library-load';
import { batchSourceLibraryTrash, changeSourceLibraryTrash } from './source-library-trash';
import { belongsToSourceWork, clearSourceWorkHistory } from './source-work-history';
import { sourceWorkSessionId } from './source-work-reading-time';
import { recoverSourceStreamVisits } from '../../external-sources/source-stream-visit-journal';
import { latestSourceVisits, sourceReleaseReadingState } from './source-release-reading';
import { useLibraryWorkCovers } from './use-library-work-covers';
import { useSourceLibraryProgress } from './use-source-library-progress';
import { useSourceStreamProgress } from './use-source-stream-progress';
import { useStreamSaveQueue } from './use-stream-save-queue';
import { taskProgressPercent } from '../../components/task-progress';
import { randomUuid } from '../../utils/random-uuid';
import { useSourceWorkLayout } from './source-work-layout';
import { sourceCachePolicy } from '../../external-sources/cache-policy';
import { storedSourcePage, saveSourceCache, cachePageId } from '../../external-sources/cached-page';
import type { HostedImageDownload, PreparedServerImport } from '../../services/import/hosted-image-import';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterAndSortReleases } from './source-release-list-model';
import { completeSeriesCatalog } from './complete-series-catalog';
import { useSourceAutomaticDownload } from './use-source-automatic-download';
import { useDownloadRetention } from './use-download-retention';
import {
  releasePreferenceId,
  type SourceReleasePreference,
  type SourceDownloadQueue,
  sourceDownloadQueueId,
} from '../../external-sources/source-user-state';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { persistentId128 } from '@boaa/text-core/hash';
import type { Chapter, Novel } from '../../domain/types';
import type {
  ExternalItemKey,
  ExternalItemSummary,
  ExternalSourceBrowseMode,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceLink,
  ExternalSourceListInput,
  ExternalSourceFilterDefinition,
  ExternalSourceFilterValue,
  ExternalSourceWorkDetail,
} from '../../external-sources/contracts';
import { externalItemKeyId, externalSourceLinkId } from '../../external-sources/contracts';
import { supportsExternalSourceLibrary } from '../../external-sources/source-capabilities';
import {
  externalSourceCatalogPreferenceId,
  externalSourceDefaultFolderId,
  externalSourceSubscriptionId,
  type ExternalSourceCatalogPreference,
  type ExternalSourceDefaultFolder,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { ImportController, ImportProgress } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import type { SuwayomiSeriesChapterInput } from '../../external-sources/suwayomi/suwayomi-series-cbz';
import {
  acquireExternalSourcePendingLinks,
  finalizeExternalSourceLinks,
  finalizeImporterResolvedExternalSourceLinks,
  checkpointImportedExternalSourceLinks,
  restoreExternalSourceLinks,
  saveExternalSourceLinks,
} from '../../external-sources/link-import-reconciliation';
import {
  externalReleaseRevisionChanged,
  externalItemSectionId,
  localSeriesDetail,
  projectLocalSeries,
  projectLocalSeriesReadingStates,
  type SerialReleaseReadingState,
} from './serial-work-projection';
import { projectImportProgress, type ImportTaskView } from '../import/import-task-projection';
import { externalDocumentCollectionId } from '../../external-sources/series/document-series-identity';
import { mergeSeriesCatalogItems } from './series-catalog-pagination';

interface ActiveSerialImportQueue {
  readonly sourceId: string;
  readonly collectionKey: string;
  readonly batchId: string;
  targetBookId: string;
  readonly externalWorkId?: string;
  readonly items: SerialSourceItem[];
  readonly itemKeys: Set<string>;
  readonly taskIdByItemKey: Map<string, string>;
  accepting: boolean;
  silentSuccess: boolean;
}

export type * from './external-source-controller-contract';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
  ExternalSourceView,
  ExternalSourceBreadcrumb,
  ExternalSourceImportProgress,
  ExternalSourceNavigationSnapshot,
  UseExternalSourceControllerOptions,
} from './external-source-controller-contract';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function normalizedHash(value: string | undefined): string | undefined {
  return (
    value
      ?.replace(/^sha256:/i, '')
      .trim()
      .toLocaleLowerCase() || undefined
  );
}

function currentIso(): string {
  return new Date().toISOString();
}

function externalImportOperationId(scope: string): string {
  const nonce =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? randomUuid()
      : Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('');
  return persistentId128('external_import_operation', [scope, currentIso(), nonce]);
}

function filterChanges(
  definitions: readonly ExternalSourceFilterDefinition[] | undefined,
  values: Readonly<Record<string, ExternalSourceFilterValue>>,
) {
  return (definitions ?? []).flatMap((definition) => {
    if (!('defaultValue' in definition)) return [];
    const value = values[definition.id] ?? definition.defaultValue;
    return [{ position: definition.position, groupPosition: definition.groupPosition, value }];
  });
}

export function useExternalSourceController(options: UseExternalSourceControllerOptions): ExternalSourceController {
  const preferenceScope = options.settingsScope?.startsWith('hosted-account:') ? options.settingsScope : undefined;
  const sourceReadMode = useCallback(
    (item: Parameters<typeof baseSourceReadMode>[0], port?: Parameters<typeof baseSourceReadMode>[1]) =>
      baseSourceReadMode(item, port, sourceReadingPreferences(preferenceScope)),
    [preferenceScope],
  );
  const preferTextLibrary = useCallback(
    (item: Parameters<typeof basePreferTextLibrary>[0], port?: Parameters<typeof basePreferTextLibrary>[1]) =>
      basePreferTextLibrary(item, port, preferenceScope),
    [preferenceScope],
  );

  const [workLayout] = useSourceWorkLayout();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [open, setOpen] = useState(false);
  const directStreamEntry = useRef(false);
  const libraryOpenRef = useRef<(item: ExternalSourceItemView) => Promise<boolean>>();
  const {
    streaming,
    beginStream,
    resumeSourceVisit,
    startResume,
    cancelResume,
    closeStream: clearStream,
  } = useSourceStreamSession({
    options,
    open,
    items: () => rawItems,
    onStreamStarted: (item) => {
      if (openRef.current) return;
      directStreamEntry.current = true;
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesChapters([]);
      setRawItems([]);
      setActiveSourceId(item.key.connectorId as ExtensionContributionId);
      setDetail({ title: item.collection?.title ?? item.title });
      setOpen(true);
    },
    openLibrary: async (item) => {
      await libraryOpenRef.current?.(item);
    },
  });
  const [activeSourceId, setActiveSourceId] = useState<ExtensionContributionId>();
  const [blockingBusy, setBusy] = useState(false);
  const catalogQuery = useSourceCatalogQuery({
    registry: options.registry,
    hostContext: options.hostContext,
    state: options.state,
    settingsScope: options.settingsScope,
    extensionRevision: options.extensionRevision,
    activeSourceId,
    blocked: blockingBusy,
    notify: options.notify,
    reconcile: (...args) => reconcileSubscriptionPage(...args),
    retainSelection: (keys) => setSelectedKeys((current) => new Set([...current].filter((key) => keys.has(key)))),
  });
  const {
    state: catalogState,
    loadPage,
    listAbortRef,
    localSeriesPageSeedRef,
    isCurrentOwner: catalogOwnerIsCurrent,
    isCurrentConnection: catalogConnectionIsCurrent,
  } = catalogQuery;
  const {
    loading,
    catalogLoading,
    catalogItems,
    nextCursor,
    stale,
    listFailure,
    catalogDetail,
    browse,
    catalogBrowse,
    catalogBrowseParentRef,
    filterValues,
  } = catalogState;
  const {
    setLoading,
    setCatalogLoading,
    setRawItems,
    setNextCursor,
    setStale,
    setListFailure,
    setDetail,
    setBrowse,
    setCatalogBrowse,
    setCatalogBrowseParentRef,
    setFilterValues,
  } = catalogQuery.setters;
  const navigationIsCurrent = useCallback(
    (sourceId: ExtensionContributionId, connection: ExternalSourceConnectionStatus, navigation: AbortController) => {
      if (!catalogOwnerIsCurrent() || navigation.signal.aborted || listAbortRef.current !== navigation) return false;
      if (catalogConnectionIsCurrent(sourceId, connection)) return true;
      // The request has not reached transport yet; discard its visual seed if its connection changed while waiting.
      setDetail(undefined);
      setRawItems([]);
      setBrowse(undefined);
      setNextCursor(undefined);
      setLoading(false);
      setCatalogLoading(false);
      return false;
    },
    [
      catalogOwnerIsCurrent,
      catalogConnectionIsCurrent,
      listAbortRef,
      setDetail,
      setRawItems,
      setBrowse,
      setNextCursor,
      setLoading,
      setCatalogLoading,
    ],
  );

  const [libraryBootstrap, setLibraryBootstrap] = useState<NonNullable<ExternalSourceController['libraryBootstrap']>>({
    status: 'loading',
  });
  const libraryLoaded = useRef(false);
  const libraryLoadGeneration = useRef(0);
  const [readingHistoryLoading, setReadingHistoryLoading] = useState(false);
  const streamCatalog = useSourceReaderCatalog(streaming?.item, options, loading || catalogLoading);
  const [importBusy, setImportBusy] = useState(false);
  const [selectedBatchActive, setSelectedBatchActive] = useState(false);
  const [tasks, setTasks] = useState<ImportTaskView[]>([]);
  const [releasePreferences, setReleasePreferences] = useState<readonly SourceReleasePreference[]>([]);
  const preferenceByKey = useMemo(
    () => new Map(releasePreferences.map((item) => [externalItemKeyId(item.source), item])),
    [releasePreferences],
  );
  const busy = blockingBusy || importBusy;
  const [coverUrls, setCoverUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const rawItems = useMemo(
    () =>
      catalogItems.map((item) =>
        item.coverRef && coverUrls.has(externalItemKeyId(item.coverRef))
          ? { ...item, thumbnailUrl: coverUrls.get(externalItemKeyId(item.coverRef)) }
          : item,
      ),
    [catalogItems, coverUrls],
  );
  const [links, setLinks] = useState<readonly ExternalSourceLink[]>([]);
  const [novels, setNovels] = useState<readonly Novel[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const detail = useMemo(
    () =>
      catalogDetail?.coverRef && coverUrls.has(externalItemKeyId(catalogDetail.coverRef))
        ? { ...catalogDetail, thumbnailUrl: coverUrls.get(externalItemKeyId(catalogDetail.coverRef)) }
        : catalogDetail,
    [catalogDetail, coverUrls],
  );
  const [localSeriesBookId, setLocalSeriesBookId] = useState<string>();
  const [localSeriesSeedNovel, setLocalSeriesSeedNovel] = useState<Novel>();
  const [localSeriesSourceId, setLocalSeriesSourceId] = useState<ExtensionContributionId>();
  const [localSeriesReadingStates, setLocalSeriesReadingStates] = useState<
    ReadonlyMap<string, SerialReleaseReadingState>
  >(() => new Map());
  const [localSeriesChapters, setLocalSeriesChapters] = useState<readonly Chapter[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<readonly ExternalSourceBreadcrumb[]>([{ label: '최상위 폴더' }]);
  const [defaultFolder, setDefaultFolder] = useState<ExternalSourceDefaultFolder>();
  const [progress, setProgress] = useState<ExternalSourceImportProgress>();
  const [subscriptions, setSubscriptions] = useState<readonly ExternalSourceSubscriptionRecord[]>([]);
  const [brokerRevision, setBrokerRevision] = useState(0);
  const itemNavigationPendingRef = useRef(false);
  const serialImportQueueRef = useRef<ActiveSerialImportQueue>();
  const downloadAbortRef = useRef<AbortController>();
  const libraryAddAbortRef = useRef<AbortController>();
  const importRef = useRef<ImportController>();
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const {
    recoverableDownloads,
    checkpointDownloadQueue,
    refreshRecovery,
    persistDownloadIntent,
    resumeDownloadQueue,
    discardDownloadQueue,
    isRecovering,
    activateQueue,
    clearActiveQueue,
  } = useSourceDownloadRecovery({
    state: options.state,
    settingsScope: options.settingsScope,
    assets: options.assets,
    waitForReadingHistory: options.waitForReadingHistory,
    listNovels: options.listNovels,
    listChapters: options.listChapters,
    registry: options.registry,
    hostContext: options.hostContext,
    notify: options.notify,
    isMounted: () => mountedRef.current,
    isBusy: () => busy,
    setImportBusy,
    setDownloadAbort: (abort) => {
      downloadAbortRef.current = abort;
    },
    importSerialItems: (sourceId, items) => importSerialItems(sourceId, items, undefined, true),
  });

  const contributions = useMemo(() => {
    void options.extensionRevision;
    void brokerRevision;
    return options.registry.getExternalSources();
  }, [brokerRevision, options.extensionRevision, options.registry]);
  const hideListCovers =
    workLayout === 'text' &&
    contributions.some(({ descriptor }) => descriptor.id === activeSourceId && descriptor.kind === 'catalog');

  const coverTargets = JSON.stringify([
    ...(detail?.coverRef ? [detail.coverRef] : []),
    ...rawItems.flatMap((item) => (item.coverRef && !hideListCovers ? [item.coverRef] : [])),
  ]);
  useEffect(() => {
    if (!open) return;
    const targets = JSON.parse(coverTargets) as ExternalItemKey[];
    const abort = new AbortController();
    const unique = [...new Map(targets.map((key) => [externalItemKeyId(key), key])).values()];
    let next = 0;
    const run = async () => {
      while (next < unique.length && !abort.signal.aborted) {
        const key = unique[next++]!;
        try {
          const thumbnailUrl = await optionsRef.current.registry.resolveExternalSourceCover?.(
            key.connectorId as ExtensionContributionId,
            optionsRef.current.hostContext,
            key,
            abort.signal,
          );
          if (abort.signal.aborted || !thumbnailUrl) continue;
          setCoverUrls((current) => new Map(current).set(externalItemKeyId(key), thumbnailUrl));
        } catch {
          /* Optional artwork never blocks catalog use or body downloads. */
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, unique.length) }, run));
    return () => abort.abort();
  }, [coverTargets, open, brokerRevision]);

  const resolveDetailThumbnail = useCallback(async (value: ExternalSourceWorkDetail, signal: AbortSignal) => {
    if (value.thumbnailUrl) return value.thumbnailUrl;
    if (!value.coverRef) return undefined;
    return optionsRef.current.registry.resolveExternalSourceCover?.(
      value.coverRef.connectorId as ExtensionContributionId,
      optionsRef.current.hostContext,
      value.coverRef,
      signal,
    );
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const sources = useMemo<readonly ExternalSourceView[]>(
    () =>
      contributions.map(({ descriptor, origin }) => {
        const connection = options.registry.getExternalSourceStatus(descriptor.id, options.hostContext);
        const sourceSubscriptions = subscriptions.filter(
          (item) =>
            !item.deletedAt &&
            item.connectorId === descriptor.id &&
            (item.accountConnectionId ?? '') === (connection.accountConnectionId ?? ''),
        );
        return {
          id: descriptor.id,
          title: descriptor.title,
          lang: descriptor.lang,
          contentKind:
            descriptor.schemaVersion === 2 && descriptor.seriesProfile
              ? descriptor.seriesProfile.kind === 'document_series'
                ? ('text' as const)
                : ('image' as const)
              : undefined,
          description: descriptor.description,
          kind: descriptor.kind,
          origin: origin ?? 'plugin',
          connection,
          extensionManager: options.registry.getSourceExtensionManager?.(descriptor.id, options.hostContext),
          connectionForm: options.registry.getExternalSourceConnectionForm?.(descriptor.id, options.hostContext),
          supportsSubscriptions: supportsExternalSourceLibrary(descriptor),
          newReleaseCount: sourceSubscriptions.reduce((total, item) => total + item.newReleaseIds.length, 0),
        };
      }),
    [contributions, options.hostContext, options.registry, subscriptions],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelResume();
      listAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
      libraryAddAbortRef.current?.abort();
      importRef.current?.cancel();
    };
  }, [cancelResume, listAbortRef]);

  useEffect(() => {
    let current = true;
    const generation = ++libraryLoadGeneration.current;
    void sourceLibraryLoad(loadSourceLibrary(optionsRef.current))
      .then(({ links, novels, subscriptions, preferences }) => {
        if (!current || !mountedRef.current || generation !== libraryLoadGeneration.current) return;
        setSubscriptions(subscriptions);
        setReleasePreferences(preferences);
        setLinks(links);
        setNovels(novels);
        libraryLoaded.current = true;
        setLibraryBootstrap({ status: 'ready' });
      })
      .catch(() => {
        if (current && mountedRef.current && generation === libraryLoadGeneration.current && !libraryLoaded.current)
          setLibraryBootstrap({ status: 'failed', message: '소스 작품을 불러오지 못했습니다. 다시 시도해 주세요.' });
      });
    return () => {
      current = false;
    };
  }, [options.extensionRevision, options.libraryRevision]);

  useEffect(() => {
    if (sources.length === 0) {
      setActiveSourceId(undefined);
      setOpen(false);
      setRawItems([]);
      setDetail(undefined);
      setDefaultFolder(undefined);
      return;
    }
    const activeSource = activeSourceId ? sources.find((source) => source.id === activeSourceId) : undefined;
    if (activeSource) {
      if (open && activeSource.connection.state !== 'connected' && !localSeriesBookId) setOpen(false);
      return;
    }
    if (open && !localSeriesBookId) setOpen(false);
    setActiveSourceId(sources[0]?.id);
    setDefaultFolder(undefined);
  }, [activeSourceId, localSeriesBookId, open, setDetail, setRawItems, sources]);

  const currentParentRef = breadcrumbs.at(-1)?.parentRef;

  const refreshLocalProjection = useCallback(async () => {
    const generation = ++libraryLoadGeneration.current;
    if (!libraryLoaded.current) setLibraryBootstrap({ status: 'loading' });
    try {
      const next = await sourceLibraryLoad(loadSourceLibrary(optionsRef.current));
      if (!mountedRef.current || generation !== libraryLoadGeneration.current) return;
      setLinks(next.links);
      setNovels(next.novels);
      setSubscriptions(next.subscriptions);
      setReleasePreferences(next.preferences);
      libraryLoaded.current = true;
      setLibraryBootstrap({ status: 'ready' });
    } catch (error) {
      if (!mountedRef.current || generation !== libraryLoadGeneration.current) return;
      if (!libraryLoaded.current)
        setLibraryBootstrap({ status: 'failed', message: '소스 작품을 불러오지 못했습니다. 다시 시도해 주세요.' });
      optionsRef.current.notify(
        error instanceof Error ? error.message : '라이브러리를 확인하지 못했습니다. 다시 시도해 주세요.',
        'warning',
      );
    }
  }, []);

  const streamProgress = useSourceStreamProgress({
    current: () => optionsRef.current,
    lastReadAt: releasePreferences.reduce(
      (latest, preference) => [latest, preference.lastReadAt ?? '', preference.readChangedAt ?? ''].sort().at(-1)!,
      '',
    ),
    isRead: (item) => preferenceByKey.get(externalItemKeyId(item.key))?.read === true,
    onRead: (preference) => {
      if (mountedRef.current)
        setReleasePreferences((previous) => [...previous.filter((record) => record.id !== preference.id), preference]);
    },
    onSaved: (novel) => {
      if (mountedRef.current) setNovels((previous) => [...previous.filter((record) => record.id !== novel.id), novel]);
    },
  });
  const { reconcile: reconcileStreamProgress, recordVisit } = streamProgress;
  const streamReadingActive = Boolean(streaming);
  const normalReadingBookId = options.readingTarget?.novelId;
  const normalReadingSectionId = options.readingTarget?.sectionId;
  useEffect(() => {
    if (streamReadingActive || !normalReadingBookId || !normalReadingSectionId) return;
    let active = true;
    void import('./source-stream-library')
      .then(async ({ sourceReadingTargetItem }) => {
        const item = await sourceReadingTargetItem(optionsRef.current, {
          novelId: normalReadingBookId,
          sectionId: normalReadingSectionId,
        });
        if (active && item) await recordVisit(item);
      })
      .catch(() => optionsRef.current.notify('읽던 회차를 저장하지 못했습니다.', 'warning'));
    return () => {
      active = false;
    };
  }, [normalReadingBookId, normalReadingSectionId, streamReadingActive, recordVisit]);
  // Background imports can finish after the reader has already moved to another episode.
  const streamLibraryVersion = JSON.stringify([
    links
      .map((link) =>
        JSON.stringify([
          externalItemKeyId(link.source),
          link.localBookId,
          link.pendingImport,
          link.activeContentRevisionId,
        ]),
      )
      .sort(),
    novels.map((novel) => JSON.stringify([novel.id, novel.activeContentRevisionId])).sort(),
  ]);
  useEffect(() => {
    void reconcileStreamProgress();
  }, [streamLibraryVersion, reconcileStreamProgress]);

  const publishCommittedNovel = useCallback(
    async (novel: Novel) => {
      const links = await optionsRef.current.state.listLinks();
      // Recovery still needs an authoritative catalog read before reconciling pending links.
      if (links.some((link) => link.localBookId === novel.id && link.pendingImport)) {
        await refreshLocalProjection();
        return;
      }
      if (!mountedRef.current) return;
      setLinks(links);
      setNovels((current) => [...current.filter((item) => item.id !== novel.id), novel]);
    },
    [refreshLocalProjection],
  );

  const replaceSubscription = useCallback((next: ExternalSourceSubscriptionRecord) => {
    setSubscriptions((current) => [...current.filter((item) => item.id !== next.id), next]);
  }, []);

  const {
    checkingSubscriptions,
    checkSubscriptions,
    reconcileSubscriptionPage,
    cancel: cancelSubscriptionChecks,
  } = useSourceSubscriptionRefresh({
    registry: options.registry,
    state: options.state,
    hostContext: options.hostContext,
    source: sources.find((source) => source.id === activeSourceId),
    subscriptions,
    busy,
    foreground: open && !loading && !currentParentRef && !detail,
    onRecord: replaceSubscription,
    onSnapshot: setSubscriptions,
    notify: options.notify,
  });

  const persistCatalogPreference = useCallback(
    async (
      sourceId: ExtensionContributionId,
      parentRef: string | undefined,
      mode: Exclude<ExternalSourceBrowseMode, 'search'> | undefined,
      values: Readonly<Record<string, ExternalSourceFilterValue>>,
      definitions?: readonly ExternalSourceFilterDefinition[],
    ) => {
      if (!parentRef || !mode) return;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source?.kind !== 'catalog' || source.connection.state !== 'connected') return;
      const preference = {
        id: externalSourceCatalogPreferenceId(sourceId, source.connection.accountConnectionId, parentRef),
        connectorId: sourceId,
        accountConnectionId: source.connection.accountConnectionId,
        parentRef,
        browseMode: mode,
        filterValues: values,
        filters: filterChanges(definitions, values),
        updatedAt: currentIso(),
        schemaVersion: 1,
      } satisfies ExternalSourceCatalogPreference;
      await optionsRef.current.state.saveCatalogPreference(preference);
    },
    [sources],
  );

  const loadSourceStart = useCallback(
    async (sourceId: ExtensionContributionId, intent: SourceCatalogQueryIntent = 'navigation') => {
      if (!catalogOwnerIsCurrent()) return;
      cancelResume();
      listAbortRef.current?.abort();
      const navigation = new AbortController();
      listAbortRef.current = navigation;
      setListFailure(undefined);
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
      if (connection.state !== 'connected') {
        setLoading(false);
        return;
      }
      setLoading(true);
      setDetail(undefined);
      setRawItems([]);
      setBrowse(undefined);
      setNextCursor(undefined);
      const savedFolder = await optionsRef.current.state
        .getDefaultFolder(sourceId, connection.accountConnectionId)
        .catch(() => undefined);
      if (!navigationIsCurrent(sourceId, connection, navigation)) return;
      setDefaultFolder(savedFolder);
      setQuery('');
      setCatalogBrowse(undefined);
      setCatalogBrowseParentRef(undefined);
      setFilterValues({});
      setSelectedKeys(new Set());
      setBreadcrumbs(savedFolder ? [{ label: '최상위 폴더' }, ...savedFolder.breadcrumbs] : [{ label: '최상위 폴더' }]);
      await refreshLocalProjection();
      if (!navigationIsCurrent(sourceId, connection, navigation)) return;
      const loaded = await loadPage(
        { parentRef: savedFolder?.parentRef },
        false,
        sourceId,
        !savedFolder,
        false,
        intent,
      );
      if (!savedFolder || loaded !== false || !mountedRef.current || !catalogOwnerIsCurrent()) return;
      await optionsRef.current.state
        .deleteDefaultFolder(sourceId, connection.accountConnectionId)
        .catch(() => undefined);
      if (!catalogOwnerIsCurrent()) return;
      setDefaultFolder(undefined);
      setBreadcrumbs([{ label: '최상위 폴더' }]);
      optionsRef.current.notify('기본 폴더를 열 수 없어 최상위 폴더부터 표시합니다.', 'warning');
      await loadPage({ parentRef: undefined }, false, sourceId, true, false, intent);
    },
    [
      cancelResume,
      catalogOwnerIsCurrent,
      listAbortRef,
      loadPage,
      navigationIsCurrent,
      refreshLocalProjection,
      setBrowse,
      setCatalogBrowse,
      setCatalogBrowseParentRef,
      setDetail,
      setFilterValues,
      setListFailure,
      setLoading,
      setNextCursor,
      setRawItems,
    ],
  );

  const refresh = useCallback(async () => {
    if (!activeSourceId) return;
    await refreshLocalProjection();
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
      undefined,
      true,
      true,
    );
  }, [activeSourceId, browse, currentParentRef, filterValues, loadPage, query, refreshLocalProjection]);

  const show = useCallback(
    (requestedSourceId?: ExtensionContributionId) => {
      if (blockingBusy) return;
      if (importBusy && requestedSourceId && requestedSourceId !== activeSourceId) return;
      if (importBusy && activeSourceId && (!requestedSourceId || requestedSourceId === activeSourceId)) {
        setOpen(true);
        return;
      }
      const sourceId =
        (requestedSourceId &&
        sources.some((source) => source.id === requestedSourceId && source.connection.state === 'connected')
          ? requestedSourceId
          : undefined) ??
        (activeSourceId &&
        sources.some((source) => source.id === activeSourceId && source.connection.state === 'connected')
          ? activeSourceId
          : undefined) ??
        sources.find((source) => source.connection.state === 'connected')?.id;
      if (!sourceId) return;
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setOpen(true);
      setActiveSourceId(sourceId);
      setLoading(true);
      void loadSourceStart(sourceId);
    },
    [activeSourceId, blockingBusy, importBusy, loadSourceStart, setLoading, sources],
  );

  const close = useCallback(() => {
    directStreamEntry.current = false;
    cancelResume();
    const wasOpen = openRef.current;
    listAbortRef.current?.abort();
    setCatalogLoading(false);
    setListFailure(undefined);
    openRef.current = false;
    setOpen(false);
    if (!importBusy) {
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
    }
    if (importBusy && wasOpen) optionsRef.current.notify('다운로드는 백그라운드에서 계속됩니다.');
  }, [cancelResume, importBusy, listAbortRef, setCatalogLoading, setListFailure]);

  const resolveSourceSeriesBook = useCallback(
    async (novel: Novel) => {
      cancelResume();
      const abort = startResume();
      if (novel.format === 'image_archive') return true;
      if (novel.format !== 'txt' || novel.documentSectionCount === undefined) return false;
      try {
        const current = optionsRef.current;
        await current.waitForReadingHistory?.();
        const links = await current.state.listLinks();
        if (abort.signal.aborted || !mountedRef.current) return undefined;
        return links.some((link) => link.localBookId === novel.id && !link.pendingImport && link.collectionRemoteId);
      } catch (error) {
        if (!abort.signal.aborted && mountedRef.current)
          optionsRef.current.notify(
            error instanceof Error ? error.message : '작품 정보를 불러오지 못했습니다.',
            'warning',
          );
        return undefined;
      }
    },
    [cancelResume, startResume],
  );

  const showLocalSeries = useCallback(
    async (novel: Novel, intent: SourceCatalogQueryIntent = 'navigation') => {
      if (!catalogOwnerIsCurrent()) return;
      cancelResume();
      if (blockingBusy && intent !== 'command-refresh') return;
      listAbortRef.current?.abort();
      const navigation = new AbortController();
      listAbortRef.current = navigation;
      setListFailure(undefined);
      // Show the selected book immediately; never keep the library waiting for network reads.
      localSeriesPageSeedRef.current = undefined;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setRawItems([]);
      setDetail(localSeriesDetail(novel));
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setStale(false);
      setBrowse(undefined);
      setBreadcrumbs([{ label: '라이브러리' }, { label: novel.title }]);
      setLoading(true);
      setCatalogLoading(false);
      setOpen(true);
      let localData;
      try {
        await optionsRef.current.waitForReadingHistory?.();
        localData = await Promise.all([
          optionsRef.current.state.listLinks(),
          optionsRef.current.listChapters(novel.id),
          optionsRef.current.getNovel(novel.id),
          recoverSourceStreamVisits(optionsRef.current.settingsScope, optionsRef.current.state),
        ]);
      } catch {
        if (!mountedRef.current || navigation.signal.aborted || listAbortRef.current !== navigation) return;
        setLoading(false);
        optionsRef.current.notify('회차 정보를 불러오지 못했습니다. 다시 시도해 주세요.', 'warning');
        return;
      }
      if (!mountedRef.current || navigation.signal.aborted || listAbortRef.current !== navigation) return;
      const [allLinks, chapters, freshNovel, preferences] = localData;
      setReleasePreferences(preferences);
      if (!freshNovel || freshNovel.deletedAt) {
        setLoading(false);
        setOpen(false);
        optionsRef.current.notify('삭제되었거나 사용할 수 없는 작품입니다.', 'warning');
        return;
      }
      const relatedLinks = allLinks.filter((link) => link.localBookId === novel.id && link.collectionRemoteId);
      // The caller may hold the pre-reader render snapshot. Prefer the just-loaded progress.
      novel = freshNovel;
      const sourceId = relatedLinks[0]?.source.connectorId as ExtensionContributionId | undefined;
      const collectionRemoteId = relatedLinks[0]?.collectionRemoteId;
      const connection = sourceId
        ? optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext)
        : undefined;
      const canLoadCatalog = Boolean(sourceId && collectionRemoteId && connection?.state === 'connected');
      // Mark provisional local rows before publishing them, including unbatched async renders.
      setLoading(false);
      setCatalogLoading(canLoadCatalog);
      const local = projectLocalSeries(novel, chapters, allLinks);
      const localSeed = {
        sourceId,
        accountConnectionId: relatedLinks[0]?.source.accountConnectionId,
        parentRef: collectionRemoteId,
        items: local.items,
        remoteItems: [] as readonly ExternalItemSummary[],
        detail: localSeriesDetail(novel),
      };
      localSeriesPageSeedRef.current = localSeed;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(sourceId);
      setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters));
      setLocalSeriesChapters(chapters);
      setNovels((current) => [...current.filter((candidate) => candidate.id !== novel.id), novel]);
      setLinks(local.links);
      setRawItems(local.items);
      setDetail(localSeriesDetail(novel));
      setBrowse(undefined);
      setCatalogBrowse(undefined);
      setCatalogBrowseParentRef(undefined);
      setFilterValues({});
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setStale(false);
      setQuery('');
      setDefaultFolder(undefined);
      setBreadcrumbs([{ label: '라이브러리' }, { label: novel.title, parentRef: collectionRemoteId }]);
      if (sourceId) setActiveSourceId(sourceId);
      setOpen(true);

      if (!sourceId || !collectionRemoteId || !canLoadCatalog) return;
      const loaded = await loadPage({ parentRef: collectionRemoteId }, false, sourceId, false, false, intent);
      if (!mountedRef.current || loaded === undefined || localSeriesPageSeedRef.current !== localSeed) return;
      setDetail((current) => current ?? localSeriesDetail(novel));
    },
    [
      catalogOwnerIsCurrent,
      cancelResume,
      blockingBusy,
      listAbortRef,
      setListFailure,
      localSeriesPageSeedRef,
      setRawItems,
      setDetail,
      setNextCursor,
      setStale,
      setBrowse,
      setLoading,
      setCatalogLoading,
      setCatalogBrowse,
      setCatalogBrowseParentRef,
      setFilterValues,
      loadPage,
    ],
  );

  const selectSource = useCallback(
    async (id: ExtensionContributionId) => {
      if (importBusy && id !== activeSourceId) return;
      listAbortRef.current?.abort();
      setListFailure(undefined);
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setActiveSourceId(id);
      await loadSourceStart(id);
    },
    [activeSourceId, importBusy, listAbortRef, loadSourceStart, setListFailure],
  );

  const search = useCallback(async () => {
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
    );
  }, [browse, currentParentRef, filterValues, loadPage, query]);

  const setBrowseMode = useCallback(
    async (mode: Exclude<ExternalSourceBrowseMode, 'search'>) => {
      setQuery('');
      const loaded = await loadPage(
        { parentRef: currentParentRef, browseMode: mode, filters: filterChanges(browse?.filters, filterValues) },
        false,
      );
      if (loaded !== false && activeSourceId) {
        await persistCatalogPreference(activeSourceId, currentParentRef, mode, filterValues, browse?.filters).catch(
          () => undefined,
        );
      }
    },
    [activeSourceId, browse, currentParentRef, filterValues, loadPage, persistCatalogPreference],
  );

  const openCatalogBrowse = useCallback(
    async (mode: Exclude<ExternalSourceBrowseMode, 'search'>) => {
      if (!activeSourceId || !catalogBrowse || blockingBusy) return;
      const parentRef = catalogBrowseParentRef;
      const crumbIndex = parentRef ? breadcrumbs.findIndex((crumb) => crumb.parentRef === parentRef) : 0;
      setBreadcrumbs(crumbIndex >= 0 ? breadcrumbs.slice(0, crumbIndex + 1) : [{ label: '최상위 폴더' }]);
      setQuery('');
      setDetail(undefined);
      setRawItems([]);
      setBrowse(undefined);
      setNextCursor(undefined);
      setSelectedKeys(new Set());
      const loaded = await loadPage(
        {
          parentRef,
          browseMode: mode,
          filters: filterChanges(catalogBrowse.filters, filterValues),
        },
        false,
      );
      if (loaded !== false) {
        await persistCatalogPreference(activeSourceId, parentRef, mode, filterValues, catalogBrowse.filters).catch(
          () => undefined,
        );
      }
    },
    [
      activeSourceId,
      blockingBusy,
      breadcrumbs,
      catalogBrowse,
      catalogBrowseParentRef,
      filterValues,
      loadPage,
      setDetail,
      setRawItems,
      setBrowse,
      setNextCursor,
      persistCatalogPreference,
    ],
  );

  const setFilterValue = useCallback(
    (id: string, value: ExternalSourceFilterValue) => {
      setFilterValues((current) => ({ ...current, [id]: value }));
    },
    [setFilterValues],
  );

  const applyFilters = useCallback(async () => {
    const loaded = await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: 'search',
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
    );
    if (loaded !== false && activeSourceId && !query.trim()) {
      await persistCatalogPreference(
        activeSourceId,
        currentParentRef,
        browse?.activeMode === 'latest' ? 'latest' : 'popular',
        filterValues,
        browse?.filters,
      ).catch(() => undefined);
    }
  }, [activeSourceId, browse, currentParentRef, filterValues, loadPage, persistCatalogPreference, query]);

  const resetFilters = useCallback(async () => {
    const defaults = defaultFilterValues(browse?.filters);
    setFilterValues(defaults);
    const loaded = await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, defaults),
      },
      false,
    );
    if (loaded !== false && activeSourceId && !query.trim()) {
      await persistCatalogPreference(
        activeSourceId,
        currentParentRef,
        browse?.activeMode === 'latest' ? 'latest' : 'popular',
        defaults,
        browse?.filters,
      ).catch(() => undefined);
    }
  }, [
    activeSourceId,
    browse?.activeMode,
    browse?.filters,
    currentParentRef,
    loadPage,
    persistCatalogPreference,
    query,
    setFilterValues,
  ]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
        cursor: nextCursor,
      },
      true,
    );
  }, [browse, currentParentRef, filterValues, loadPage, nextCursor, query]);

  const { linkByKey, novelById, unresolvedLibraryWorks } = useSourceLibraryLinks(links, novels, subscriptions);
  const catalogNovel = useMemo(() => {
    if (!detail || !open) return undefined;
    if (localSeriesBookId) return novelById.get(localSeriesBookId) ?? localSeriesSeedNovel;
    const account = sources.find((source) => source.id === activeSourceId)?.connection.accountConnectionId;
    const link = links.find(
      (candidate) =>
        candidate.source.connectorId === activeSourceId &&
        (candidate.source.accountConnectionId ?? '') === (account ?? '') &&
        candidate.collectionRemoteId ===
          (currentParentRef ?? rawItems.find((item) => item.collection)?.collection?.remoteId) &&
        !novelById.get(candidate.localBookId)?.deletedAt,
    );
    return link ? novelById.get(link.localBookId) : undefined;
  }, [
    activeSourceId,
    currentParentRef,
    detail,
    links,
    localSeriesBookId,
    localSeriesSeedNovel,
    novelById,
    open,
    sources,
    rawItems,
  ]);
  const [catalogChapters, setCatalogChapters] = useState<{ novel: Novel; chapters: readonly Chapter[] }>();
  useEffect(() => {
    let active = true;
    setCatalogChapters(undefined);
    if (catalogNovel) {
      void optionsRef.current
        .listChapters(catalogNovel.id)
        .then((chapters) => {
          if (active) setCatalogChapters({ novel: catalogNovel, chapters });
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [catalogNovel]);
  const catalogReadingStates = useMemo(
    () =>
      catalogNovel && catalogChapters?.novel === catalogNovel
        ? projectLocalSeriesReadingStates(catalogNovel, catalogChapters.chapters, rawItems)
        : new Map<string, SerialReleaseReadingState>(),
    [catalogNovel, catalogChapters, rawItems],
  );
  const effectiveLocalSeriesReadingStates = useMemo(() => {
    if (!localSeriesBookId) return localSeriesReadingStates;
    const localNovel = novelById.get(localSeriesBookId) ?? localSeriesSeedNovel;
    if (!localNovel) return localSeriesReadingStates;
    const projected = projectLocalSeriesReadingStates(localNovel, localSeriesChapters, rawItems);
    if ([...projected.values()].includes('current')) return projected;
    const previousCurrent = [...localSeriesReadingStates].find(([, state]) => state === 'current')?.[0];
    if (!previousCurrent || !projected.has(previousCurrent)) return projected;
    return new Map(
      [...projected].map(([sectionId, state]) => [sectionId, sectionId === previousCurrent ? 'current' : state]),
    );
  }, [localSeriesBookId, localSeriesChapters, localSeriesReadingStates, localSeriesSeedNovel, novelById, rawItems]);
  const taskByItemKey = useMemo(
    () => new Map(tasks.flatMap((task) => (task.externalItemKey ? [[task.externalItemKey, task] as const] : []))),
    [tasks],
  );
  const sourceVisits = useMemo(() => latestSourceVisits(releasePreferences), [releasePreferences]);
  const items = useMemo<readonly ExternalSourceItemView[]>(() => {
    const readAtBySection = new Map(
      [...localSeriesChapters, ...(catalogChapters?.chapters ?? [])].map((chapter) => [
        chapter.documentSectionId ?? chapter.id,
        chapter.documentSectionReadAt,
      ]),
    );
    const knownChapters = catalogChapters?.novel === catalogNovel ? catalogChapters?.chapters : undefined;
    const downloadedSections =
      knownChapters && (knownChapters.length === 0 || knownChapters.some((chapter) => chapter.documentSectionId))
        ? new Set(knownChapters.map((chapter) => chapter.documentSectionId))
        : undefined;
    const remoteItems = localSeriesPageSeedRef.current?.remoteItems;
    const remoteKeys = remoteItems ? new Set(remoteItems.map((item) => externalItemKeyId(item.key))) : undefined;
    return rawItems.map((item) => {
      const key = externalItemKeyId(item.key);
      const preference = preferenceByKey.get(key);
      const actualReadAt = readAtBySection.get(externalItemSectionId(item));
      const useReadOverride =
        preference?.read !== undefined &&
        (!actualReadAt || (preference.readChangedAt ?? preference.updatedAt) >= actualReadAt);
      const link = linkByKey.get(key);
      const linkedNovel = link ? novelById.get(link.localBookId) : undefined;
      const completedTask = taskByItemKey.get(key)?.phase === 'complete' ? taskByItemKey.get(key) : undefined;
      const completedNovel = completedTask?.targetBookId ? novelById.get(completedTask.targetBookId) : undefined;
      const localNovel =
        (linkedNovel?.deletedAt ? undefined : linkedNovel) ?? (completedNovel?.deletedAt ? undefined : completedNovel);
      const missingDownload = Boolean(
        item.release &&
        localNovel &&
        localNovel === catalogNovel &&
        downloadedSections &&
        !downloadedSections.has(externalItemSectionId(item)),
      );
      const unsupported = item.kind === 'folder' || item.importability === 'unsupported';
      const changed = Boolean(link && externalReleaseRevisionChanged(item, link.importedRemoteRevision));
      return {
        ...item,
        originalTitle: item.title,
        title: preference?.title ?? item.title,
        selected: selectedKeys.has(key),
        importState: unsupported
          ? 'unsupported'
          : (link || completedTask) && localNovel && !missingDownload
            ? changed
              ? 'update_available'
              : 'imported'
            : 'available',
        localBookId: localNovel?.id,
        localBookTitle: localNovel?.title,
        localOrderOnly: Boolean(localSeriesBookId && remoteKeys && !remoteKeys.has(key)),
        readingState: sourceReleaseReadingState(
          item,
          useReadOverride
            ? preference!.read
              ? 'read'
              : 'unread'
            : item.release
              ? ((localSeriesBookId ? effectiveLocalSeriesReadingStates : catalogReadingStates).get(
                  externalItemSectionId(item),
                ) ?? 'unread')
              : undefined,
          sourceVisits,
        ),
      };
    });
  }, [
    localSeriesChapters,
    catalogChapters?.chapters,
    catalogChapters?.novel,
    catalogNovel,
    localSeriesPageSeedRef,
    rawItems,
    preferenceByKey,
    linkByKey,
    novelById,
    taskByItemKey,
    selectedKeys,
    localSeriesBookId,
    effectiveLocalSeriesReadingStates,
    catalogReadingStates,
    sourceVisits,
  ]);

  const linkedSeriesBookIds = useMemo(
    () => new Set(links.filter((link) => link.collectionRemoteId).map((link) => link.localBookId)),
    [links],
  );

  const changeReleasePreferences = useCallback(
    async (targets: readonly ExternalSourceItemView[], patch: { title?: string; read?: boolean }) => {
      if (busy || !targets.length || !optionsRef.current.state.saveReleasePreferences) return;
      setBusy(true);
      try {
        const stored = (await optionsRef.current.state.listReleasePreferences?.()) ?? [];
        const byId = new Map(stored.map((item) => [item.id, item]));
        const changed = targets
          .filter((item) => item.release)
          .map((item) => {
            const id = releasePreferenceId(item.key);
            const previous = byId.get(id);
            const changedAt = new Date(
              Math.max(
                Date.now(),
                (Date.parse(previous?.updatedAt ?? '') || 0) + 1,
                (Date.parse(previous?.readChangedAt ?? '') || 0) + 1,
                (Date.parse(previous?.lastReadAt ?? '') || 0) + 1,
              ),
            ).toISOString();
            return {
              ...previous,
              id,
              kind: 'releasePreference' as const,
              source: item.key,
              ...patch,
              ...(item.collection ? { collectionRemoteId: item.collection.remoteId } : {}),
              ...(patch.read !== undefined ? { readChangedAt: changedAt } : {}),
              updatedAt: changedAt,
            };
          });
        await optionsRef.current.state.saveReleasePreferences(changed);
        changed.forEach((item) => byId.set(item.id, item));
        if (mountedRef.current) setReleasePreferences([...byId.values()]);
        await optionsRef.current.onLibraryChanged();
        optionsRef.current.notify(
          patch.title !== undefined
            ? '회차 제목을 변경했습니다.'
            : `${changed.length}개 회차를 ${patch.read ? '읽음' : '안 읽음'}으로 변경했습니다.`,
          'success',
        );
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '회차 정보를 저장하지 못했습니다.',
          'warning',
        );
        throw error;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy],
  );

  const renameRelease = useCallback(
    async (item: ExternalSourceItemView, title: string) => {
      const normalized = title.trim();
      if (!normalized || normalized.length > 200) throw new Error('제목을 1~200자로 입력해 주세요.');
      await changeReleasePreferences([item], { title: normalized });
    },
    [changeReleasePreferences],
  );
  const setReleasesRead = useCallback(
    (targets: readonly ExternalSourceItemView[], read: boolean) => changeReleasePreferences(targets, { read }),
    [changeReleasePreferences],
  );
  const markPreviousReleasesRead = useCallback(
    async (item: ExternalSourceItemView) => {
      if (catalogLoading || nextCursor || listFailure) {
        optionsRef.current.notify('전체 목차를 확인한 뒤 이전 회차를 일괄 변경할 수 있습니다.', 'warning');
        return;
      }
      const ordered = filterAndSortReleases(items, '', 'all', 'asc');
      const index = ordered.findIndex((candidate) => externalItemKeyId(candidate.key) === externalItemKeyId(item.key));
      if (index <= 0) {
        optionsRef.current.notify('이전 회차가 없습니다.');
        return;
      }
      await changeReleasePreferences(ordered.slice(0, index), { read: true });
    },
    [catalogLoading, nextCursor, listFailure, items, changeReleasePreferences],
  );

  const activeSubscription = useMemo(() => {
    if (!activeSourceId || !currentParentRef) return undefined;
    const connection = sources.find((source) => source.id === activeSourceId)?.connection;
    return subscriptions.find(
      (item) =>
        !item.deletedAt &&
        item.connectorId === activeSourceId &&
        item.collectionRemoteId === currentParentRef &&
        (item.accountConnectionId ?? '') === (connection?.accountConnectionId ?? ''),
    );
  }, [activeSourceId, currentParentRef, sources, subscriptions]);

  const { resolve: resolveLibraryCover, peek: peekLibraryCover } = useMemo(
    () => createLibraryCoverResolver(() => optionsRef.current),
    [],
  );
  const coveredLibraryWorks = useLibraryWorkCovers(
    unresolvedLibraryWorks,
    JSON.stringify([
      options.settingsScope,
      brokerRevision,
      options.extensionRevision,
      sources.map((source) => [source.id, source.connection]),
    ]),
    resolveLibraryCover,
    peekLibraryCover,
  );

  const libraryWorks = useSourceWorkMetadata(coveredLibraryWorks, options, replaceSubscription);

  const sourceWorkProgress = useSourceLibraryProgress(
    { ...options, readingActive: options.readingActive || Boolean(streaming) },
    {
      subscriptions,
      links,
      preferences: releasePreferences,
      novels,
      listChapters: (novelId) => optionsRef.current.listChapters(novelId),
    },
  );

  const isWorkInLibrary = useCallback(
    (item: ExternalSourceItemView) => {
      if (item.kind !== 'work' || !item.navigationRef) return false;
      return subscriptions.some(
        (subscription) =>
          !subscription.deletedAt &&
          subscription.connectorId === item.key.connectorId &&
          (subscription.accountConnectionId ?? '') === (item.key.accountConnectionId ?? '') &&
          subscription.collectionRemoteId === item.navigationRef,
      );
    },
    [subscriptions],
  );

  const acknowledgeImportedReleaseIds = useCallback(
    async (
      sourceId: string,
      accountConnectionId: string | undefined,
      collectionRemoteId: string,
      releaseIds: readonly string[],
    ) => {
      if (releaseIds.length === 0) return;
      const id = externalSourceSubscriptionId(sourceId, accountConnectionId, collectionRemoteId);
      const current = (await optionsRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current) return;
      const acknowledged = new Set(releaseIds);
      const next = {
        ...current,
        newReleaseIds: current.newReleaseIds.filter((releaseId) => !acknowledged.has(releaseId)),
        updatedAt: currentIso(),
      } satisfies ExternalSourceSubscriptionRecord;
      await optionsRef.current.state.saveSubscription(next);
      if (mountedRef.current) replaceSubscription(next);
    },
    [replaceSubscription],
  );

  const deletionPendingRef = useRef(false);
  const [deletingDownloads, setDeletingDownloads] = useState(false);
  const deleteDownloads = useCallback(
    async (selected: readonly ExternalSourceItemView[]) => {
      if (busy || deletionPendingRef.current) return;
      const downloaded = selected.filter(
        (item) =>
          item.release &&
          item.localBookId &&
          (item.importState === 'imported' || item.importState === 'update_available'),
      );
      const bookId = downloaded[0]?.localBookId;
      if (!bookId || downloaded.some((item) => item.localBookId !== bookId)) return;
      if (
        !optionsRef.current.confirm(
          `${downloaded.length}개 회차의 다운로드를 삭제할까요? 작품은 라이브러리에 남으며 다시 다운로드할 수 있습니다.`,
        )
      )
        return;
      deletionPendingRef.current = true;
      setDeletingDownloads(true);
      const originalSeed = localSeriesPageSeedRef.current;
      setBusy(true);
      try {
        const options = optionsRef.current;
        if (!options.assets) throw new Error('다운로드 저장소를 사용할 수 없습니다.');
        const { removeDownloadedReleases } = await import('../../external-sources/series/remove-downloaded-releases');
        const novel = await removeDownloadedReleases({
          bookId,
          sectionIds: downloaded.map(externalItemSectionId),
          assets: options.assets,
          importService: options.importService,
          getNovel: options.getNovel,
        });
        const chapters = await options.listChapters(bookId);
        if (mountedRef.current) {
          const removedKeys = new Set(downloaded.map((item) => externalItemKeyId(item.key)));
          setTasks((current) =>
            current.filter((task) => !task.externalItemKey || !removedKeys.has(task.externalItemKey)),
          );
          setSelectedKeys((current) => new Set([...current].filter((key) => !removedKeys.has(key))));
          setCatalogChapters({ novel, chapters });
          setNovels((current) => [...current.filter((item) => item.id !== bookId), novel]);
          if (localSeriesBookId === bookId && localSeriesPageSeedRef.current === originalSeed) {
            setLocalSeriesChapters(chapters);
            setLocalSeriesSeedNovel(novel);
            setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters));
            const local = projectLocalSeries(novel, chapters, await options.state.listLinks());
            const seed = localSeriesPageSeedRef.current;
            if (seed) {
              localSeriesPageSeedRef.current = { ...seed, items: local.items };
              setRawItems(mergeSeriesCatalogItems(local.items, seed.remoteItems));
            }
          }
        }
        await options.onLibraryChanged();
        options.notify(`${downloaded.length}개 회차의 다운로드를 삭제했습니다.`, 'success');
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '다운로드를 삭제하지 못했습니다.',
          'warning',
        );
      } finally {
        deletionPendingRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setDeletingDownloads(false);
        }
      }
    },
    [busy, localSeriesBookId, localSeriesPageSeedRef, setRawItems],
  );

  const toggleItem = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllSupported = useCallback(
    (selected: boolean, itemKeys?: readonly string[]) => {
      const scope = itemKeys ? new Set(itemKeys) : undefined;
      const eligible = items
        .filter(
          (item) =>
            item.kind !== 'folder' &&
            item.importState !== 'unsupported' &&
            (item.importState !== 'imported' || Boolean(item.release)),
        )
        .map((item) => externalItemKeyId(item.key))
        .filter((key) => !scope || scope.has(key));
      setSelectedKeys((current) => {
        const next = scope ? new Set(current) : new Set<string>();
        for (const key of eligible) {
          if (selected) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [items],
  );

  const canQueueItem = useCallback(
    (item: ExternalSourceItemView) => {
      const queue = serialImportQueueRef.current;
      return Boolean(
        importBusy &&
        queue?.accepting &&
        queue.sourceId === activeSourceId &&
        isSerialSourceItem(item) &&
        serialCollectionKey(item) === queue.collectionKey,
      );
    },
    [activeSourceId, importBusy],
  );

  const importSerialItems = useCallback(
    async (
      sourceId: ExtensionContributionId,
      initialItems: readonly SerialSourceItem[],
      background?: AbortSignal,
      detached = false,
      silentSuccess = false,
    ): Promise<boolean> => {
      const importable = filterAndSortReleases(initialItems, '', 'all', 'asc') as SerialSourceItem[];
      const collectionKeys = new Set(importable.map(serialCollectionKey));
      if (collectionKeys.size !== 1) return false;
      let collection = importable[0]!.collection;
      const accountConnectionId = importable[0]!.key.accountConnectionId;
      const currentSubscription =
        subscriptions.find(
          (record) =>
            record.connectorId === sourceId &&
            (record.accountConnectionId ?? '') === (accountConnectionId ?? '') &&
            record.collectionRemoteId === collection.remoteId,
        ) ??
        (
          await optionsRef.current.state
            .listSubscriptions(sourceId, accountConnectionId)
            .catch(() => [] as readonly ExternalSourceSubscriptionRecord[])
        ).find((record) => record.collectionRemoteId === collection.remoteId);
      if (currentSubscription?.titleOverride) collection = { ...collection, title: currentSubscription.titleOverride };
      background?.throwIfAborted();
      if (background && automaticDownloadBlockedRef.current) return true;
      const sourceDetail = background || detached ? undefined : detail;
      let sourceThumbnailUrl = sourceDetail?.thumbnailUrl ?? currentSubscription?.thumbnailUrl;
      // Reader/background downloads have no mounted detail page. Resolve the work's
      // artwork by its stable source identity instead of keeping the chapter preview.
      const canResolveSourceCover = Boolean(
        sourceThumbnailUrl ||
        sourceDetail?.coverRef ||
        (optionsRef.current.assets?.saveApprovedEnrichmentCover &&
          optionsRef.current.registry.resolveExternalSourceCover),
      );
      const resolveSourceThumbnail = async (signal: AbortSignal) => {
        if (sourceThumbnailUrl) return sourceThumbnailUrl;
        if (sourceDetail?.coverRef) sourceThumbnailUrl = await resolveDetailThumbnail(sourceDetail, signal);
        return (sourceThumbnailUrl ??= await optionsRef.current.registry.resolveExternalSourceCover?.(
          sourceId,
          optionsRef.current.hostContext,
          { connectorId: sourceId, accountConnectionId, remoteId: collection.remoteId },
          signal,
        ));
      };
      const selectedUpdateCount = importable.filter((item) => item.importState === 'update_available').length;
      if (
        selectedUpdateCount > 0 &&
        !optionsRef.current.confirm(
          `${selectedUpdateCount}개 회차의 원격 revision이 변경되었습니다. 본문이나 회차 구성이 달라졌으면 기존 작품 ID를 유지한 채 갱신합니다. 완료된 회차는 이후 실패에도 유지됩니다. 계속할까요?`,
        )
      ) {
        return true;
      }

      const [{ createSeriesDownloadQueue }, { createHostedImageDownloadQueue }] = await Promise.all([
        import('../../external-sources/series/series-download-queue'),
        import('../../external-sources/series/hosted-image-download-queue'),
      ]);
      background?.throwIfAborted();
      if (background && automaticDownloadBlockedRef.current) return true;
      const createDownloads = (signal: AbortSignal, taskIds: Map<string, string>) =>
        createSeriesDownloadQueue({
          sourceId,
          registry: optionsRef.current.registry,
          hostContext: optionsRef.current.hostContext,
          items: importable,
          signal,
          onStage: (item, phase) => {
            if (!mountedRef.current) return;
            const id = taskIds.get(externalItemKeyId(item.key));
            setTasks((current) =>
              current.map((task) => (task.id === id ? { ...task, phase, percent: undefined } : task)),
            );
          },
        });

      if (collection.seriesProfile?.kind === 'document_series') {
        const batchId = `external-document-series-${randomUuid()}`;
        const taskIdByItemKey = new Map<string, string>();
        const serialQueue: ActiveSerialImportQueue = {
          sourceId,
          collectionKey: serialCollectionKey(importable[0]!),
          batchId,
          targetBookId: externalDocumentCollectionId(importable[0]!.key, collection.remoteId),
          externalWorkId: currentSubscription?.id,
          items: importable,
          itemKeys: new Set(importable.map((item) => externalItemKeyId(item.key))),
          taskIdByItemKey,
          accepting: true,
          silentSuccess,
        };
        const queuedTasks = importable.map((item, index): ImportTaskView => {
          const itemKey = externalItemKeyId(item.key);
          const id = `${batchId}-${index}`;
          taskIdByItemKey.set(itemKey, id);
          return {
            id,
            batchId,
            source: 'external_source',
            title: collection.title,
            fileName: item.release.title,
            targetBookId: serialQueue.targetBookId,
            externalWorkId: currentSubscription?.id,
            externalItemKey: itemKey,
            phase: 'queued',
            current: index + 1,
            total: importable.length,
          };
        });
        setTasks((current) => [
          ...current.filter((task) => !task.externalItemKey || !taskIdByItemKey.has(task.externalItemKey)),
          ...queuedTasks,
        ]);
        serialImportQueueRef.current = serialQueue;
        const abort = new AbortController();
        downloadAbortRef.current = abort;
        const documentPort = optionsRef.current.importService.importPrepared
          ? optionsRef.current.registry.getHostedDocumentImport?.(sourceId)
          : undefined;
        const hostedDocumentDownloads = documentPort
          ? createHostedImageDownloadQueue({
              sourceId,
              registry: optionsRef.current.registry,
              hostContext: optionsRef.current.hostContext,
              port: documentPort,
              document: true,
              items: importable,
              signal: abort.signal,
              onStage: (item, phase) => {
                if (!mountedRef.current) return;
                const id = taskIdByItemKey.get(externalItemKeyId(item.key));
                setTasks((current) =>
                  current.map((task) => (task.id === id ? { ...task, phase, percent: undefined } : task)),
                );
              },
            })
          : undefined;
        const localDocumentDownloads = documentPort ? undefined : createDownloads(abort.signal, taskIdByItemKey);
        const downloads = hostedDocumentDownloads ?? localDocumentDownloads!;
        setImportBusy(true);
        setSelectedBatchActive(true);
        let completed = 0;
        let replacedRelease = false;
        let coverAttempted = false;
        let coverWarning: string | undefined;
        try {
          const { importDocumentSeries } =
            await import('../../external-sources/series/document-series-import-coordinator');
          // Capture each accepted selection once. Additions made while a batch is
          // running are imported against its committed source in the next pass.
          for (let offset = 0; offset < importable.length;) {
            abort.signal.throwIfAborted();
            const selectedItems = importable.slice(offset, offset + 1);
            const committedBefore = completed;
            await importDocumentSeries({
              sourceId,
              items: selectedItems.map((item) => ({ ...item, collection })),
              registry: optionsRef.current.registry,
              hostContext: optionsRef.current.hostContext,
              state: optionsRef.current.state,
              assets: optionsRef.current.assets,
              importService: optionsRef.current.importService,
              getNovel: (id) => optionsRef.current.getNovel(id),
              signal: abort.signal,
              download: localDocumentDownloads ? () => localDocumentDownloads.take(offset) : undefined,
              hosted:
                documentPort && hostedDocumentDownloads
                  ? {
                      port: documentPort,
                      download: async () => {
                        const receipt = await hostedDocumentDownloads.take(offset);
                        hostedDocumentDownloads.forget(receipt.artifactId);
                        return receipt;
                      },
                    }
                  : undefined,
              onReplacedRelease: () => {
                replacedRelease = true;
              },
              onProgress: (value) => {
                completed = committedBefore + value.committed;
                if (mountedRef.current) {
                  const activeKey = value.item && externalItemKeyId(value.item.key);
                  const batchKeys = new Set(value.items?.map((item) => externalItemKeyId(item.key)));
                  setTasks((current) =>
                    current.map((task) => {
                      if (task.batchId !== batchId || task.phase === 'complete' || task.phase === 'cancelling')
                        return task;
                      if (value.detail && task.externalItemKey && batchKeys.has(task.externalItemKey))
                        return { ...task, ...projectImportProgress(value.detail) };
                      if (activeKey === task.externalItemKey)
                        return { ...task, phase: value.stage ?? 'downloading', percent: undefined };
                      return task;
                    }),
                  );
                  setProgress({
                    current: committedBefore + value.received,
                    total: importable.length,
                    completed,
                    failed: 0,
                    linkedExisting: 0,
                    fileName: value.title,
                    phase: value.detail ? 'importing' : 'downloading',
                    detail: value.detail,
                  });
                }
              },
              onCommitted: async (novel, committedItems) => {
                const keys = new Set(committedItems.map((item) => externalItemKeyId(item.key)));
                await checkpointDownloadQueue(committedItems);
                serialQueue.targetBookId = novel.id;
                if (mountedRef.current)
                  setTasks((current) =>
                    current.map((task) =>
                      task.batchId === batchId
                        ? {
                            ...task,
                            targetBookId: novel.id,
                            ...(task.externalItemKey && keys.has(task.externalItemKey)
                              ? { phase: 'complete' as const, percent: 100, error: undefined }
                              : {}),
                          }
                        : task,
                    ),
                  );
                await acknowledgeImportedReleaseIds(
                  sourceId,
                  accountConnectionId,
                  collection.remoteId,
                  committedItems.map((item) => item.key.remoteId),
                );
                if (mountedRef.current)
                  setSelectedKeys((current) => new Set([...current].filter((key) => !keys.has(key))));
                await Promise.all([publishCommittedNovel(novel), optionsRef.current.onLibraryItemCommitted?.(novel)]);
                if (!coverAttempted && canResolveSourceCover) {
                  coverAttempted = true;
                  try {
                    await (
                      await import('./source-cover')
                    ).persistSourceCover(
                      optionsRef.current.assets,
                      novel,
                      () => resolveSourceThumbnail(abort.signal),
                      abort.signal,
                    );
                  } catch (error) {
                    coverWarning = error instanceof Error ? error.message : '원격 표지를 저장하지 못했습니다.';
                  }
                }
              },
            });
            offset += selectedItems.length;
          }
          serialQueue.accepting = false;
          if ((!background && !serialQueue.silentSuccess) || coverWarning)
            optionsRef.current.notify(
              `${collection.title}의 ${completed}개 회차를 저장하거나 확인했습니다.${
                replacedRelease ? ' 수정 회차에서 연결할 수 없는 위치·메모는 복구 대기로 보관합니다.' : ''
              }${coverWarning ? ` 표지는 저장하지 못했습니다. ${coverWarning}` : ''}`,
              coverWarning ? 'warning' : 'success',
            );
        } catch (error) {
          downloads.close();
          serialQueue.accepting = false;
          if (mountedRef.current)
            setTasks((current) =>
              current.map((task) =>
                task.batchId === batchId && task.phase !== 'complete'
                  ? {
                      ...task,
                      phase: 'failed',
                      percent: undefined,
                      measurement: undefined,
                      error: isAbort(error)
                        ? '다운로드를 취소했습니다.'
                        : error instanceof Error
                          ? error.message
                          : '텍스트 회차를 가져오지 못했습니다.',
                    }
                  : task,
              ),
            );
          optionsRef.current.notify(
            `${completed}개 회차는 저장되었습니다. ${
              isAbort(error)
                ? '진행 중인 묶음 가져오기를 취소했습니다.'
                : error instanceof Error
                  ? error.message
                  : '텍스트 회차를 가져오지 못했습니다.'
            }`,
            'warning',
          );
        } finally {
          downloads.close();
          serialQueue.accepting = false;
          if (serialImportQueueRef.current === serialQueue) serialImportQueueRef.current = undefined;
          if (downloadAbortRef.current === abort) downloadAbortRef.current = undefined;
          if (!documentPort || !serialQueue.silentSuccess || completed < serialQueue.items.length)
            await Promise.all([optionsRef.current.onLibraryChanged(), refreshLocalProjection()]).catch(() => undefined);
          if (mountedRef.current) {
            setTasks((current) =>
              current.filter((task) => task.batchId !== batchId || (!abort.signal.aborted && task.phase === 'failed')),
            );
            setImportBusy(false);
            setSelectedBatchActive(false);
            setProgress(undefined);
          }
        }
        return true;
      }

      const hostedPort = optionsRef.current.importService.importPrepared
        ? optionsRef.current.registry.getHostedImageImport?.(sourceId)
        : undefined;
      let hostedDownloads: ReturnType<typeof createHostedImageDownloadQueue> | undefined;
      let useHosted: boolean | undefined;
      const batchId = `external-series-${Date.now()}-${collection.remoteId}`;
      const targetBookId = persistentId128('external_series', [serialCollectionKey(importable[0]!)]);
      const taskIdByItemKey = new Map<string, string>();
      const queuedTasks = importable.map((item, index) => {
        const itemKey = externalItemKeyId(item.key);
        const taskId = `${batchId}-${index}`;
        taskIdByItemKey.set(itemKey, taskId);
        return {
          id: taskId,
          batchId,
          source: 'external_source' as const,
          title: collection.title,
          fileName: item.release.title,
          targetBookId,
          externalWorkId: currentSubscription?.id,
          externalItemKey: itemKey,
          phase: 'queued' as const,
          current: index + 1,
          total: importable.length,
        };
      });
      setTasks((current) => [
        ...current.filter((task) => !task.externalItemKey || !taskIdByItemKey.has(task.externalItemKey)),
        ...queuedTasks,
      ]);
      const serialQueue: ActiveSerialImportQueue = {
        sourceId,
        collectionKey: serialCollectionKey(importable[0]!),
        batchId,
        targetBookId,
        externalWorkId: currentSubscription?.id,
        items: importable,
        itemKeys: new Set(importable.map((item) => externalItemKeyId(item.key))),
        taskIdByItemKey,
        accepting: true,
        silentSuccess,
      };
      serialImportQueueRef.current = serialQueue;
      setImportBusy(true);
      const abort = new AbortController();
      downloadAbortRef.current = abort;
      const downloads = createDownloads(abort.signal, taskIdByItemKey);
      let importedNovel: Novel | undefined;
      let changedCount = 0;
      let revisionChecked = 0;
      let stagedLinks: readonly ExternalSourceLink[] = [];
      let previousLinks: readonly ExternalSourceLink[] = [];
      let contentApplied = false;
      let coverWarning: string | undefined;
      let coverAttempted = false;
      let libraryProjectionPublished = false;
      const completedKeys = new Set<string>();
      let activeTaskId: string | undefined;
      try {
        let { novels: knownNovels, links: knownLinks } = await loadSourceLibrary(optionsRef.current);
        // Fetch ahead, but build/commit one chapter at a time. Completed chapters
        // survive a later failure/cancel and remain immediately readable.
        for (let batchIndex = 0; batchIndex < importable.length; batchIndex += 1) {
          const selectedItem = importable[batchIndex]!;
          const selectedItemKey = externalItemKeyId(selectedItem.key);
          activeTaskId = taskIdByItemKey.get(selectedItemKey);
          stagedLinks = [];
          previousLinks = [];
          contentApplied = false;
          abort.signal.throwIfAborted();
          const sameConnection = (link: ExternalSourceLink) =>
            link.source.connectorId === importable[0]!.key.connectorId &&
            (link.source.accountConnectionId ?? '') === (importable[0]!.key.accountConnectionId ?? '');
          const relatedRemoteIds = new Set(
            rawItems
              .filter(isSerialSourceItem)
              .filter((item) => serialCollectionKey(item) === serialCollectionKey(importable[0]!))
              .map((item) => item.key.remoteId),
          );
          const relatedLinks = knownLinks.filter(
            (link) =>
              sameConnection(link) &&
              (link.collectionRemoteId === collection.remoteId || relatedRemoteIds.has(link.source.remoteId)),
          );
          const knownNovelIds = new Set(knownNovels.map((novel) => novel.id));
          const targetIds = new Set(
            relatedLinks.filter((link) => knownNovelIds.has(link.localBookId)).map((link) => link.localBookId),
          );
          if (targetIds.size > 1) {
            throw new Error(
              '이 작품의 회차가 여러 라이브러리 항목에 따로 연결되어 있습니다. 중복 작품 정리는 다음 마이그레이션 단계에서 지원합니다.',
            );
          }
          const existingLocalBookId = [...targetIds][0];
          if (existingLocalBookId) {
            serialQueue.targetBookId = existingLocalBookId;
            setTasks((current) =>
              current.map((task) => (task.batchId === batchId ? { ...task, targetBookId: existingLocalBookId } : task)),
            );
          }
          const existingNovel = existingLocalBookId
            ? knownNovels.find((novel) => novel.id === existingLocalBookId)
            : undefined;
          if (existingNovel?.deletedAt)
            throw new Error('휴지통에 있는 작품입니다. 복원하거나 영구 삭제한 뒤 다시 가져와 주세요.');
          const incrementalSeriesAppend = Boolean(
            optionsRef.current.importService.supportsIncrementalImageSeriesAppend &&
            existingNovel?.format === 'image_archive' &&
            existingNovel.activeContentRevisionId &&
            existingNovel.documentSectionCount !== undefined &&
            relatedLinks.some((link) => link.collectionRemoteId === collection.remoteId),
          );
          if (useHosted === undefined) {
            // Legacy standalone archives still use the existing full merge path for this batch.
            useHosted = Boolean(hostedPort && (!existingLocalBookId || incrementalSeriesAppend));
            if (useHosted)
              hostedDownloads = createHostedImageDownloadQueue({
                sourceId,
                registry: optionsRef.current.registry,
                hostContext: optionsRef.current.hostContext,
                port: hostedPort!,
                items: importable,
                signal: abort.signal,
                onProgress: (item, value) => {
                  if (!mountedRef.current || abort.signal.aborted) return;
                  const id = taskIdByItemKey.get(externalItemKeyId(item.key));
                  setTasks((current) =>
                    current.map((task) =>
                      task.id === id && ['queued', 'downloading', 'verifying'].includes(task.phase)
                        ? {
                            ...task,
                            phase: value.phase === 'downloading' ? 'downloading' : 'verifying',
                            measurement: value,
                            percent: taskProgressPercent(value),
                          }
                        : task,
                    ),
                  );
                },
                onStage: (item, phase) => {
                  if (!mountedRef.current || abort.signal.aborted) return;
                  const id = taskIdByItemKey.get(externalItemKeyId(item.key));
                  setTasks((current) =>
                    current.map((task) =>
                      task.id === id && task.phase !== 'cancelling'
                        ? { ...task, phase, percent: undefined, measurement: undefined }
                        : task,
                    ),
                  );
                },
              });
          }
          const existingSource =
            existingLocalBookId && !incrementalSeriesAppend
              ? await (
                  await import('../../repositories/comic-source-export')
                ).exportPortableBookSource(optionsRef.current.assets, existingLocalBookId)
              : undefined;
          if (existingLocalBookId && !incrementalSeriesAppend && !existingSource) {
            throw new Error('기존 연재 작품의 원본을 찾지 못해 회차를 안전하게 합칠 수 없습니다.');
          }
          const legacyLink = relatedLinks.find(
            (link) => link.localBookId === existingLocalBookId && !link.collectionRemoteId,
          );
          const legacyItem = legacyLink
            ? rawItems
                .filter(isSerialSourceItem)
                .find((item) => externalItemKeyId(item.key) === externalItemKeyId(legacyLink.source))
            : undefined;
          const existingLegacyChapter =
            legacyLink && legacyItem
              ? {
                  remoteId: legacyItem.key.remoteId,
                  release: legacyItem.release,
                  remoteRevision: legacyLink.importedRemoteRevision,
                  sourceContentHash:
                    normalizedHash(legacyLink.importedSourceContentHash) ??
                    normalizedHash(existingNovel?.sourceContentHash) ??
                    (existingSource
                      ? (normalizedHash(
                          await hashBlobInChunks(existingSource.blob, {
                            shouldCancel: () => abort.signal.aborted,
                          }),
                        ) ?? '')
                      : ''),
                }
              : undefined;

          let preparedDownload: HostedImageDownload | undefined;
          let preparedChanged = false;
          const downloadedChapters: SuwayomiSeriesChapterInput[] = [];
          const checked = new Map<
            string,
            { item: SerialSourceItem; sourceHash: string; remoteRevision?: string; existingLink?: ExternalSourceLink }
          >();
          for (const item of [selectedItem]) {
            abort.signal.throwIfAborted();
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId
                    ? { ...task, phase: 'downloading', percent: undefined, measurement: undefined, error: undefined }
                    : task,
                ),
              );
            }
            setProgress({
              current: batchIndex + 1,
              total: importable.length,
              completed: changedCount,
              failed: 0,
              linkedExisting: revisionChecked,
              fileName: item.title,
              phase: 'downloading',
            });
            preparedDownload = hostedDownloads ? await hostedDownloads.take(batchIndex) : undefined;
            const downloaded = preparedDownload ? undefined : await downloads.take(batchIndex);
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId ? { ...task, phase: 'verifying', percent: undefined } : task,
                ),
              );
            }
            setProgress((current) => (current ? { ...current, phase: 'verifying' } : current));
            const sourceHash =
              preparedDownload?.sourceContentHash ??
              normalizedHash(await hashBlobInChunks(downloaded!.file, { shouldCancel: () => abort.signal.aborted })) ??
              '';
            const existingLink = knownLinks.find(
              (link) =>
                existingNovel &&
                link.localBookId === existingNovel.id &&
                externalItemKeyId(link.source) === externalItemKeyId(item.key),
            );
            checked.set(externalItemKeyId(item.key), {
              item,
              sourceHash,
              remoteRevision: preparedDownload?.remoteRevision ?? downloaded?.remoteRevision ?? item.remoteRevision,
              existingLink,
            });
            if (existingLink && normalizedHash(existingLink.importedSourceContentHash) === normalizedHash(sourceHash)) {
              if (preparedDownload) hostedDownloads!.release(preparedDownload.artifactId);
              revisionChecked += 1;
              continue;
            }
            if (preparedDownload) {
              preparedChanged = true;
              continue;
            }
            downloadedChapters.push({
              remoteId: item.key.remoteId,
              release: item.release,
              remoteRevision: downloaded!.remoteRevision ?? item.remoteRevision,
              sourceContentHash: sourceHash,
              expectedPreviousSourceContentHash: existingLink?.importedSourceContentHash,
              file: downloaded!.file,
            });
          }

          if (downloadedChapters.length > 0 || preparedChanged) {
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId ? { ...task, phase: 'preparing', percent: undefined } : task,
                ),
              );
            }
            setProgress({
              current: batchIndex + 1,
              total: importable.length,
              completed: changedCount,
              failed: 0,
              linkedExisting: revisionChecked,
              fileName: collection.title,
              phase: 'importing',
            });
            let preparedImport: PreparedServerImport | undefined;
            let aggregate: File | undefined;
            if (preparedDownload) {
              const previous = checked.get(externalItemKeyId(selectedItem.key))?.existingLink;
              preparedImport = await hostedPort!.assemble(
                {
                  artifactId: preparedDownload.artifactId,
                  collection,
                  remoteId: selectedItem.key.remoteId,
                  release: selectedItem.release,
                  remoteRevision: preparedDownload.remoteRevision ?? selectedItem.remoteRevision,
                  expectedPreviousSourceContentHash: previous?.importedSourceContentHash,
                  clientBookId: existingLocalBookId ?? targetBookId,
                  ...(incrementalSeriesAppend
                    ? {
                        importMode: 'append_image_series',
                        baseActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                      }
                    : {}),
                },
                abort.signal,
              );
              hostedDownloads!.release(preparedDownload.artifactId);
            } else {
              const { buildSuwayomiSeriesArchive } =
                await import('../../external-sources/suwayomi/suwayomi-series-cbz');
              aggregate = await buildSuwayomiSeriesArchive({
                collection,
                targetBookId: incrementalSeriesAppend ? existingLocalBookId : undefined,
                chapters: downloadedChapters,
                existingArchive: incrementalSeriesAppend ? undefined : existingSource?.blob,
                existingLegacyChapter: incrementalSeriesAppend ? undefined : existingLegacyChapter,
                signal: abort.signal,
              });
            }
            const uploadedSourceContentHash =
              preparedImport?.sourceContentHash ??
              (await hashBlobInChunks(aggregate!, {
                shouldCancel: () => abort.signal.aborted,
              }));
            const localBookId =
              existingLocalBookId ?? persistentId128('external_series', [serialCollectionKey(importable[0]!)]);
            const stagedAt = currentIso();
            const operationId = externalImportOperationId(serialCollectionKey(importable[0]!));
            const stagedByKey = new Map<string, ExternalSourceLink>();
            relatedLinks
              .filter((link) => link.localBookId === localBookId)
              .forEach((link) =>
                stagedByKey.set(externalItemKeyId(link.source), {
                  ...link,
                  collectionRemoteId: collection.remoteId,
                  pendingImport: {
                    operationId,
                    stagedAt,
                    hadExistingLink: true,
                    previousActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                    expectedActiveSourceContentHash: uploadedSourceContentHash,
                    bookIdMayChange: optionsRef.current.importService.mayChangeBookId,
                    sourceHashResolvedByImporter: incrementalSeriesAppend || undefined,
                    collectionRemoteId: collection.remoteId,
                    importedRemoteRevision: link.importedRemoteRevision,
                    importedSourceContentHash: link.importedSourceContentHash,
                  },
                }),
              );
            checked.forEach(({ item, sourceHash, remoteRevision, existingLink }) => {
              stagedByKey.set(externalItemKeyId(item.key), {
                ...(existingLink ?? {
                  id: externalSourceLinkId(item.key),
                  source: item.key,
                  localBookId,
                  linkedAt: stagedAt,
                }),
                localBookId,
                collectionRemoteId: collection.remoteId,
                pendingImport: {
                  operationId,
                  stagedAt,
                  hadExistingLink: Boolean(existingLink),
                  previousActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                  expectedActiveSourceContentHash: uploadedSourceContentHash,
                  bookIdMayChange: optionsRef.current.importService.mayChangeBookId,
                  sourceHashResolvedByImporter: incrementalSeriesAppend || undefined,
                  collectionRemoteId: collection.remoteId,
                  importedRemoteRevision: remoteRevision,
                  importedSourceContentHash: sourceHash,
                },
              });
            });
            const nextStagedLinks = [...stagedByKey.values()];
            previousLinks = relatedLinks;
            await acquireExternalSourcePendingLinks(optionsRef.current.state, nextStagedLinks);
            stagedLinks = nextStagedLinks;
            const onImportProgress = (progressDetail: ImportProgress) => {
              if (!mountedRef.current) return;
              if (activeTaskId) {
                const projection = projectImportProgress(progressDetail);
                setTasks((current) =>
                  current.map((task) => (task.id === activeTaskId ? { ...task, ...projection } : task)),
                );
              }
              setProgress({
                current: batchIndex + 1,
                total: importable.length,
                completed: changedCount,
                failed: 0,
                linkedExisting: revisionChecked,
                fileName: collection.title,
                phase: 'importing',
                detail: progressDetail,
              });
            };
            const controller = preparedImport
              ? optionsRef.current.importService.importPrepared!(preparedImport, onImportProgress)
              : optionsRef.current.importService.importFile(
                  {
                    file: aggregate!,
                    encoding: 'auto',
                    chapterSplitMode: 'auto',
                    clientBookId: localBookId,
                    ...(incrementalSeriesAppend
                      ? {
                          importMode: 'append_image_series' as const,
                          baseActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                        }
                      : {}),
                    ...(optionsRef.current.importService.supportsExpectedSourceContentHash
                      ? { expectedSourceContentHash: uploadedSourceContentHash }
                      : {}),
                  },
                  onImportProgress,
                );
            importRef.current = controller;
            if (abort.signal.aborted) controller.cancel();
            const result = await controller.promise;
            importRef.current = undefined;
            contentApplied = true;
            changedCount += preparedChanged ? 1 : downloadedChapters.length;
            importedNovel = result.novel;
            stagedLinks = await checkpointImportedExternalSourceLinks(
              optionsRef.current.state,
              stagedLinks,
              result.novel,
            );
            importedNovel = (await optionsRef.current.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
          } else {
            importedNovel = existingNovel;
          }
          if (!importedNovel) throw new Error('가져온 연재 작품을 확인하지 못했습니다.');

          const linkedAt = currentIso();
          let nextLinks: readonly ExternalSourceLink[];
          if (stagedLinks.length > 0) {
            nextLinks = incrementalSeriesAppend
              ? await finalizeImporterResolvedExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel)
              : await finalizeExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel);
          } else {
            const byKey = new Map<string, ExternalSourceLink>();
            relatedLinks
              .filter((link) => link.localBookId === importedNovel!.id)
              .forEach((link) =>
                byKey.set(externalItemKeyId(link.source), {
                  ...link,
                  collectionRemoteId: collection.remoteId,
                  activeContentRevisionId: importedNovel!.activeContentRevisionId,
                  lastCheckedAt: linkedAt,
                }),
              );
            checked.forEach(({ item, sourceHash, remoteRevision, existingLink }) => {
              byKey.set(externalItemKeyId(item.key), {
                id: externalSourceLinkId(item.key),
                source: item.key,
                localBookId: importedNovel!.id,
                collectionRemoteId: collection.remoteId,
                importedRemoteRevision: remoteRevision,
                importedSourceContentHash: sourceHash,
                activeContentRevisionId: importedNovel!.activeContentRevisionId,
                linkedAt: existingLink?.linkedAt ?? linkedAt,
                lastCheckedAt: linkedAt,
              });
            });
            nextLinks = [...byKey.values()];
            await saveExternalSourceLinks(optionsRef.current.state, nextLinks);
          }
          await acknowledgeImportedReleaseIds(
            sourceId,
            importable[0]!.key.accountConnectionId,
            collection.remoteId,
            [...checked.values()].map(({ item }) => item.key.remoteId),
          );

          completedKeys.add(externalItemKeyId(selectedItem.key));
          await checkpointDownloadQueue([selectedItem]);
          const nextKeys = new Set(nextLinks.map((link) => externalItemKeyId(link.source)));
          knownLinks = [...knownLinks.filter((link) => !nextKeys.has(externalItemKeyId(link.source))), ...nextLinks];
          knownNovels = [...knownNovels.filter((novel) => novel.id !== importedNovel!.id), importedNovel];
          setLinks(knownLinks);
          setNovels(knownNovels);
          setSelectedKeys((current) => new Set([...current].filter((key) => key !== selectedItemKey)));
          setProgress((current) =>
            current
              ? { ...current, completed: changedCount, linkedExisting: revisionChecked, detail: undefined }
              : current,
          );
          if (activeTaskId) {
            const completedTaskId = activeTaskId;
            setTasks((current) =>
              current.map((task) =>
                task.id === completedTaskId
                  ? { ...task, phase: 'complete', percent: 100, targetBookId: importedNovel!.id }
                  : task,
              ),
            );
          }
          activeTaskId = undefined;
          if (importedNovel && !libraryProjectionPublished) {
            const published = await optionsRef.current
              .onLibraryItemCommitted?.(importedNovel)
              .then(() => true)
              .catch(() => false);
            libraryProjectionPublished = published ?? true;
          }
          // Content and its release link are usable at this point. Do not keep the
          // completed release visually blocked while optional cover persistence runs.
          // Hosted receipts carry no browser files. Also repair an embedded preview
          // when the selected release was already downloaded with identical bytes.
          if (!coverAttempted && canResolveSourceCover) {
            coverAttempted = true;
            try {
              await (
                await import('./source-cover')
              ).persistSourceCover(
                optionsRef.current.assets,
                importedNovel,
                () => resolveSourceThumbnail(abort.signal),
                abort.signal,
              );
            } catch (error) {
              coverWarning = error instanceof Error ? error.message : '원격 표지를 저장하지 못했습니다.';
            }
          }
        }
        serialQueue.accepting = false;
        await optionsRef.current.onLibraryChanged();
        await refreshLocalProjection();
        setSelectedKeys((current) => new Set([...current].filter((key) => !completedKeys.has(key))));
        const importedMessage =
          changedCount > 0
            ? `${collection.title}에 ${changedCount}개 회차를 추가하거나 갱신했습니다.${revisionChecked > 0 ? ` ${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.` : ''}`
            : `${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.`;
        if ((!background && !serialQueue.silentSuccess) || coverWarning)
          optionsRef.current.notify(
            coverWarning ? `${importedMessage} 표지는 저장하지 못했습니다. ${coverWarning}` : importedMessage,
            coverWarning ? 'warning' : 'success',
          );
      } catch (error) {
        downloads.close();
        hostedDownloads?.close();
        importRef.current = undefined;
        if (
          !contentApplied &&
          stagedLinks.length > 0 &&
          !stagedLinks.some((link) => link.pendingImport?.bookIdMayChange && !link.pendingImport.hadExistingLink)
        ) {
          await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(() => undefined);
        }
        if (changedCount > 0 || completedKeys.size > 0) {
          await optionsRef.current.onLibraryChanged().catch(() => undefined);
          await refreshLocalProjection().catch(() => undefined);
          setSelectedKeys((current) => new Set([...current].filter((key) => !completedKeys.has(key))));
        }
        const cancelled = isAbort(error);
        const message = error instanceof Error ? error.message : '회차를 가져오지 못했습니다.';
        setTasks((current) =>
          cancelled
            ? current.filter((task) => task.batchId !== batchId)
            : current
                .filter((task) => task.batchId !== batchId || task.id === activeTaskId)
                .map((task) =>
                  task.id === activeTaskId
                    ? { ...task, phase: 'failed', percent: undefined, measurement: undefined, error: message }
                    : task,
                ),
        );
        optionsRef.current.notify(
          (changedCount > 0 ? `${changedCount}개 회차는 저장되었습니다. ` : '') +
            (contentApplied
              ? `연재 본문 적용은 완료했으며 소스 연결은 다음 새로고침에서 복구합니다. ${
                  error instanceof Error ? error.message : String(error || '')
                }`.trim()
              : cancelled
                ? '가져오기를 취소했습니다. 기존 연재 작품과 연결은 유지됩니다.'
                : `연재 작품을 적용하지 못해 기존 본문과 연결을 유지했습니다. ${
                    error instanceof Error ? error.message : String(error || '')
                  }`.trim()),
          'warning',
        );
      } finally {
        downloads.close();
        hostedDownloads?.close();
        serialQueue.accepting = false;
        if (serialImportQueueRef.current === serialQueue) serialImportQueueRef.current = undefined;
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          if (!activeTaskId) setTasks((current) => current.filter((task) => task.batchId !== batchId));
          setImportBusy(false);
          setProgress(undefined);
        }
      }
      return true;
    },
    [
      acknowledgeImportedReleaseIds,
      detail,
      rawItems,
      refreshLocalProjection,
      publishCommittedNovel,
      subscriptions,
      resolveDetailThumbnail,
      checkpointDownloadQueue,
    ],
  );

  const executeImportItems = useCallback(
    async (selected: readonly ExternalSourceItemView[], detached = false, silentSuccess = false) => {
      const sourceId = detached
        ? (selected[0]?.key.connectorId as ExtensionContributionId | undefined)
        : activeSourceId;
      const importable = selected.filter(
        (item) =>
          item.kind !== 'folder' &&
          item.importState !== 'unsupported' &&
          (item.importState !== 'imported' || item.collection?.seriesProfile?.kind === 'document_series'),
      );
      if (!sourceId || importable.length === 0) return;
      const serialItems = importable.filter((item): item is SerialSourceItem => isSerialSourceItem(item));
      if (importBusy) {
        const queue = serialImportQueueRef.current;
        const sameActiveSeries = Boolean(
          !blockingBusy &&
          queue?.accepting &&
          queue.sourceId === sourceId &&
          serialItems.length === importable.length &&
          serialItems.every((item) => serialCollectionKey(item) === queue.collectionKey),
        );
        if (!sameActiveSeries || !queue) return;
        if (!silentSuccess) queue.silentSuccess = false;
        const additions = (filterAndSortReleases(serialItems, '', 'all', 'asc') as SerialSourceItem[]).filter(
          (item) => !queue.itemKeys.has(externalItemKeyId(item.key)),
        );
        if (additions.length === 0) return;
        const firstIndex = queue.items.length;
        additions.forEach((item, offset) => {
          const itemKey = externalItemKeyId(item.key);
          const taskId = `${queue.batchId}-${firstIndex + offset}`;
          queue.items.push(item);
          queue.itemKeys.add(itemKey);
          queue.taskIdByItemKey.set(itemKey, taskId);
        });
        const total = queue.items.length;
        setTasks((current) => [
          ...current.map((task) => (task.batchId === queue.batchId ? { ...task, total } : task)),
          ...additions.map((item, offset) => ({
            id: queue.taskIdByItemKey.get(externalItemKeyId(item.key))!,
            batchId: queue.batchId,
            source: 'external_source' as const,
            title: item.collection.title,
            fileName: item.release.title,
            targetBookId: queue.targetBookId,
            externalWorkId: queue.externalWorkId,
            externalItemKey: externalItemKeyId(item.key),
            phase: 'queued' as const,
            current: firstIndex + offset + 1,
            total,
          })),
        ]);
        setProgress((current) => (current ? { ...current, total } : current));
        return;
      }
      if (busy) return;
      if (
        serialItems.length === importable.length &&
        (await importSerialItems(sourceId, serialItems, undefined, detached, silentSuccess))
      )
        return;
      const selectedUpdateCount = importable.filter((item) => item.importState === 'update_available').length;
      if (
        selectedUpdateCount > 0 &&
        !optionsRef.current.confirm(
          `${selectedUpdateCount}개 작품의 원격 revision이 변경되었습니다. 계속하면 선택한 원문을 내려받아 해시를 확인하고, 실제 내용이 달라진 작품만 기존 작품 ID를 유지한 채 새 content revision으로 교체합니다. 실패한 작품은 현재 본문을 유지합니다. 계속할까요?`,
        )
      ) {
        return;
      }
      setImportBusy(true);
      let completed = 0;
      let failed = 0;
      let linkedExisting = 0;
      let updated = 0;
      let revisionChecked = 0;
      let linkRepairPending = 0;
      let cancelled = false;
      let firstFailureMessage: string | undefined;
      setProgress({ current: 0, total: importable.length, completed, failed, linkedExisting });
      try {
        const { novels: knownNovels, links } = await loadSourceLibrary(optionsRef.current);
        const knownLinks = new Map(links.map((link) => [externalItemKeyId(link.source), link]));
        for (const [index, item] of importable.entries()) {
          if (!mountedRef.current) break;
          const abort = new AbortController();
          downloadAbortRef.current = abort;
          let stagedLinks: readonly ExternalSourceLink[] = [];
          let previousLinks: readonly ExternalSourceLink[] = [];
          let contentApplied = false;
          setProgress({
            current: index + 1,
            total: importable.length,
            completed,
            failed,
            linkedExisting,
            fileName: item.title,
            phase: 'downloading',
          });
          try {
            const downloaded = await optionsRef.current.registry.downloadExternalSource(
              sourceId,
              optionsRef.current.hostContext,
              {
                key: item.key,
                fileName: item.importFileName ?? item.title,
                mimeType: item.mimeType,
                byteLength: item.byteLength,
                remoteRevision: item.remoteRevision,
              },
              abort.signal,
            );
            setProgress({
              current: index + 1,
              total: importable.length,
              completed,
              failed,
              linkedExisting,
              fileName: item.title,
              phase: 'verifying',
            });
            const sourceHash =
              normalizedHash(
                await hashBlobInChunks(downloaded.file, {
                  shouldCancel: () => abort.signal.aborted,
                }),
              ) ?? '';
            const existingLink = knownLinks.get(externalItemKeyId(item.key));
            let target = existingLink ? knownNovels.find((novel) => novel.id === existingLink.localBookId) : undefined;
            if (target?.deletedAt)
              throw new Error('휴지통에 있는 작품입니다. 복원하거나 영구 삭제한 뒤 다시 가져와 주세요.');
            if (!target) {
              target = knownNovels.find(
                (novel) =>
                  !novel.deletedAt &&
                  (normalizedHash(novel.sourceContentHash) === normalizedHash(sourceHash) ||
                    normalizedHash(novel.rawTextHash) === normalizedHash(sourceHash)),
              );
            }
            let importedNovel = target;
            const exactLinkedContent = Boolean(
              existingLink &&
              target &&
              normalizedHash(existingLink.importedSourceContentHash) === normalizedHash(sourceHash),
            );
            if (exactLinkedContent) {
              // Providers can advance metadata/revision without changing the exact source bytes.
              // In that case only the checked link revision advances; the active content stays untouched.
              revisionChecked += 1;
            } else if (!target || existingLink) {
              setProgress({
                current: index + 1,
                total: importable.length,
                completed,
                failed,
                linkedExisting,
                fileName: item.title,
                phase: 'importing',
              });
              const localBookId =
                existingLink?.localBookId ??
                target?.id ??
                persistentId128('external_item', [externalItemKeyId(item.key)]);
              const linkedAt = currentIso();
              const stagedLink: ExternalSourceLink = {
                ...(existingLink ?? {
                  id: externalSourceLinkId(item.key),
                  source: item.key,
                  localBookId,
                  linkedAt,
                }),
                localBookId,
                pendingImport: {
                  operationId: externalImportOperationId(externalItemKeyId(item.key)),
                  stagedAt: linkedAt,
                  hadExistingLink: Boolean(existingLink),
                  previousActiveContentRevisionId: target?.activeContentRevisionId,
                  expectedActiveSourceContentHash: sourceHash,
                  bookIdMayChange: optionsRef.current.importService.mayChangeBookId,
                  collectionRemoteId: existingLink?.collectionRemoteId,
                  importedRemoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
                  importedSourceContentHash: sourceHash,
                },
              };
              previousLinks = existingLink ? [existingLink] : [];
              await acquireExternalSourcePendingLinks(optionsRef.current.state, [stagedLink]);
              stagedLinks = [stagedLink];

              const controller = optionsRef.current.importService.importFile(
                {
                  file: downloaded.file,
                  encoding: 'auto',
                  chapterSplitMode: 'auto',
                  clientBookId: localBookId,
                },
                (detail) => {
                  if (!mountedRef.current) return;
                  setProgress({
                    current: index + 1,
                    total: importable.length,
                    completed,
                    failed,
                    linkedExisting,
                    fileName: item.title,
                    phase: 'importing',
                    detail,
                  });
                },
              );
              importRef.current = controller;
              const result = await controller.promise;
              importRef.current = undefined;
              contentApplied = true;
              stagedLinks = await checkpointImportedExternalSourceLinks(
                optionsRef.current.state,
                stagedLinks,
                result.novel,
              );
              importedNovel =
                (await optionsRef.current.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
              knownNovels.push(importedNovel);
              completed += 1;
              if (existingLink) updated += 1;
            } else {
              linkedExisting += 1;
            }
            if (!importedNovel) throw new Error('가져온 작품을 확인하지 못했습니다.');
            const linkedAt = currentIso();
            let link: ExternalSourceLink;
            if (stagedLinks.length > 0) {
              link = (await finalizeExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel))[0]!;
            } else {
              link = {
                id: externalSourceLinkId(item.key),
                source: item.key,
                localBookId: importedNovel.id,
                importedRemoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
                importedSourceContentHash: importedNovel.sourceContentHash ?? sourceHash,
                activeContentRevisionId: importedNovel.activeContentRevisionId,
                linkedAt: existingLink?.linkedAt ?? linkedAt,
                lastCheckedAt: linkedAt,
              };
              await saveExternalSourceLinks(optionsRef.current.state, [link]);
            }
            knownLinks.set(externalItemKeyId(item.key), link);
          } catch (error) {
            importRef.current = undefined;
            if (isAbort(error)) {
              if (
                !contentApplied &&
                stagedLinks.length > 0 &&
                !stagedLinks.some((link) => link.pendingImport?.bookIdMayChange && !link.pendingImport.hadExistingLink)
              ) {
                await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(
                  () => undefined,
                );
              }
              cancelled = true;
              break;
            }
            if (contentApplied && stagedLinks.length > 0) {
              // The canonical content is already active and the pre-import intent is durable.
              // A later projection will finalize the link without reimporting the source.
              linkRepairPending += stagedLinks.length;
              continue;
            }
            if (
              stagedLinks.length > 0 &&
              !stagedLinks.some((link) => link.pendingImport?.bookIdMayChange && !link.pendingImport.hadExistingLink)
            ) {
              await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(
                () => undefined,
              );
            }
            failed += 1;
            firstFailureMessage ??=
              error instanceof Error
                ? error.message.trim() || error.name || '외부 작품을 가져오지 못했습니다.'
                : String(error || '외부 작품을 가져오지 못했습니다.');
          }
        }
        await optionsRef.current.onLibraryChanged();
        await refreshLocalProjection();
        setSelectedKeys(new Set());
        const connected = completed - updated + linkedExisting;
        const successMessage = [
          connected > 0 ? `${connected}개 작품을 책장에 연결했습니다.` : undefined,
          updated > 0 ? `${updated}개 작품의 본문을 업데이트했습니다.` : undefined,
          revisionChecked > 0 ? `${revisionChecked}개 작품은 원문이 같아 연결 revision만 갱신했습니다.` : undefined,
          linkRepairPending > 0
            ? `${linkRepairPending}개 작품은 본문 적용을 마쳤고 소스 연결은 다음 새로고침에서 복구합니다.`
            : undefined,
        ]
          .filter((message): message is string => Boolean(message))
          .join(' ');
        if (!silentSuccess || cancelled || failed > 0 || linkRepairPending > 0)
          optionsRef.current.notify(
            cancelled
              ? `${successMessage ? `${successMessage} ` : ''}가져오기를 취소했습니다. 취소된 작품은 기존 본문과 연결을 유지합니다.`
              : failed > 0
                ? `${successMessage ? `${successMessage} ` : ''}${failed}개는 적용하지 못해 기존 본문과 연결을 유지했습니다.${firstFailureMessage ? ` 첫 오류: ${firstFailureMessage}` : ''}`
                : successMessage || '선택한 작품에 적용할 변경 사항이 없습니다.',
            cancelled || failed > 0 || linkRepairPending > 0 ? 'warning' : 'success',
          );
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '라이브러리를 확인하지 못했습니다. 다시 시도해 주세요.',
          'warning',
        );
      } finally {
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          setImportBusy(false);
          setProgress(undefined);
        }
      }
    },
    [activeSourceId, blockingBusy, busy, importBusy, importSerialItems, refreshLocalProjection],
  );

  const importItems = useCallback(
    async (
      selected: readonly ExternalSourceItemView[],
      reportRejection = false,
      detached = false,
      silentSuccess = false,
    ) => {
      if (isRecovering() || blockingBusy || (importBusy && !selected.every(canQueueItem))) {
        if (reportRejection) throw new Error('다른 다운로드가 끝난 후 저장할 수 있습니다.');
        return;
      }
      const run = async () => {
        let queue: SourceDownloadQueue | undefined;
        try {
          queue = await persistDownloadIntent(selected);
          if (queue) activateQueue(queue.id);
          await executeImportItems(selected, detached, silentSuccess);
        } catch (error) {
          if (reportRejection) throw error;
          optionsRef.current.notify(
            error instanceof Error ? error.message : '다운로드 대기열을 저장하지 못했습니다.',
            'warning',
          );
        } finally {
          if (!serialImportQueueRef.current) clearActiveQueue();
          await refreshRecovery();
        }
      };
      const first = selected[0];
      if (!importBusy && first?.collection && globalThis.navigator?.locks) {
        await navigator.locks.request(
          `boaa-source-queue:${sourceDownloadQueueId(first.key, first.collection.remoteId)}`,
          { ifAvailable: true },
          async (lock) => {
            if (lock) await run();
            else if (reportRejection)
              throw new Error('다른 탭에서 이 작품을 다운로드하고 있습니다. 완료 후 다시 시도해 주세요.');
            else optionsRef.current.notify('다른 탭에서 이 작품을 다운로드하고 있습니다.', 'warning');
          },
        );
      } else await run();
    },
    [
      executeImportItems,
      persistDownloadIntent,
      refreshRecovery,
      importBusy,
      blockingBusy,
      canQueueItem,
      activateQueue,
      clearActiveQueue,
      isRecovering,
    ],
  );

  const { enqueue: saveStream, cancel: cancelStreamSaves } = useStreamSaveQueue<ExternalSourceItemView>({
    key: (item) => externalItemKeyId(item.key),
    ready: (item) => !isRecovering() && !blockingBusy && (!importBusy || canQueueItem(item)),
    save: async (item) => {
      try {
        await importItems(
          [item],
          true,
          item.key.connectorId !== activeSourceId || item.collection?.remoteId !== currentParentRef,
        );
      } catch (error) {
        optionsRef.current.notify(error instanceof Error ? error.message : '회차를 저장하지 못했습니다.', 'warning');
        throw error;
      }
    },
  });

  // Serial import rechecks this after its own asynchronous admission preparation.
  const automaticDownloadBlockedRef = useRef(busy || importBusy || blockingBusy);
  automaticDownloadBlockedRef.current = busy || importBusy || blockingBusy;
  const downloadRetention = useDownloadRetention({
    options: { ...options, readingActive: options.readingActive || Boolean(streaming) },
    busy: busy || importBusy || blockingBusy,
    setBusy,
  });
  const automaticDownload = useSourceAutomaticDownload({
    options,
    streamItem: streaming?.item,
    busy: busy || importBusy || blockingBusy,
    queue: {
      canAccept: () =>
        !busy &&
        !importBusy &&
        !blockingBusy &&
        !downloadAbortRef.current &&
        !serialImportQueueRef.current &&
        !importRef.current,
      enqueue: (sourceId, items, signal) => importSerialItems(sourceId, items, signal),
    },
  });

  const importItem = useCallback(
    async (item: ExternalSourceItemView) => {
      await importItems([item]);
    },
    [importItems],
  );

  const continueSourceReading = useCallback(
    async (novel: Novel) => {
      cancelResume();
      const abort = startResume();
      try {
        const current = optionsRef.current;
        await current.waitForReadingHistory?.();
        abort.signal.throwIfAborted();
        await reconcileStreamProgress();
        const [preferences, bookLinks] = await Promise.all([
          recoverSourceStreamVisits(current.settingsScope, current.state),
          current.state.listLinks(),
        ]);
        abort.signal.throwIfAborted();
        if (!mountedRef.current) return true;
        const visits = latestSourceVisits(preferences);
        const visit = bookLinks
          .filter((link) => link.localBookId === novel.id && link.collectionRemoteId)
          .map((link) => visits.get(externalItemKeyId({ ...link.source, remoteId: link.collectionRemoteId! })))
          .filter((visit): visit is SourceReleasePreference => Boolean(visit))
          .sort((a, b) => b.lastReadAt!.localeCompare(a.lastReadAt!))[0];
        if (!visit || visit.readingMode !== 'stream') return false;
        const port = current.registry.getSourceStream?.(visit.source.connectorId as ExtensionContributionId);
        if (!port || isTextStream(port)) {
          const opening = showLocalSeries(novel);
          const navigation = startResume();
          await opening;
          navigation.signal.throwIfAborted();
        }
        if (mountedRef.current) await resumeSourceVisit(visit);
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          optionsRef.current.notify(
            error instanceof Error ? error.message : '읽기 기록을 확인하지 못했습니다.',
            'warning',
          );
        }
      }
      // Unknown history or cancelled navigation must never fall back to episode one.
      return true;
    },
    [cancelResume, reconcileStreamProgress, resumeSourceVisit, showLocalSeries, startResume],
  );

  const currentWorkItem = rawItems.find((item) => item.collection);
  const currentWorkVisit = currentWorkItem?.collection
    ? sourceVisits.get(externalItemKeyId({ ...currentWorkItem.key, remoteId: currentWorkItem.collection.remoteId }))
    : undefined;
  const canResumeCurrentWork = currentWorkVisit?.readingMode === 'stream';
  const resumeCurrentWork = useCallback(async () => {
    if (!currentWorkVisit?.collectionRemoteId) return;
    await reconcileStreamProgress();
    const preferences = await recoverSourceStreamVisits(optionsRef.current.settingsScope, optionsRef.current.state);
    const latest = latestSourceVisits(preferences).get(
      externalItemKeyId({
        ...currentWorkVisit.source,
        remoteId: currentWorkVisit.collectionRemoteId,
      }),
    );
    if (latest) await resumeSourceVisit(latest);
  }, [currentWorkVisit, reconcileStreamProgress, resumeSourceVisit]);

  const libraryOpen = useSourceLibraryOpen({
    options,
    importItems,
    canOpen: () => openRef.current || Boolean(optionsRef.current.readingTarget),
    canImport: () => !busy && !isRecovering(),
    prepare: async (novel, item, chapters) => {
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
      setLocalSeriesChapters(chapters);
    },
  });
  libraryOpenRef.current = async (item) => {
    const opened = await libraryOpen.open(item);
    if (opened) setOpen(false);
    return opened === true;
  };
  const importAndOpen = useCallback(
    async (item: ExternalSourceItemView) => {
      if (!item.release || item.importState !== 'available') return;
      const mode = sourceReadMode(
        item,
        optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId),
      );
      if (
        mode === 'download' &&
        isTextSourceItem(
          item,
          optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId),
        )
      ) {
        await libraryOpenRef.current?.(item);
        return;
      }
      if (mode !== 'download' && beginStream(item)) return;
      await importItems([item]);
      if (!openRef.current) return;
      const link = (await optionsRef.current.state.listLinks(item.key.connectorId)).find(
        (candidate) => externalItemKeyId(candidate.source) === externalItemKeyId(item.key),
      );
      if (!link) return;
      const novel = await optionsRef.current.getNovel(link.localBookId);
      if (!novel || novel.deletedAt) return;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
      setLocalSeriesChapters(await optionsRef.current.listChapters(novel.id));
      setOpen(false);
      await optionsRef.current.openNovel(novel, {
        documentSectionId: externalItemSectionId(item),
        documentSectionTitle: item.release.title,
      });
    },
    [importItems, beginStream, sourceReadMode],
  );

  const libraryReader = useSourceLibraryReader(
    options,
    (item) => libraryOpenRef.current?.(item) ?? Promise.resolve(),
    Boolean(libraryOpen.openingItemKey),
    libraryOpen.prefetch,
    libraryOpen.pending,
  );

  const importSelected = useCallback(async () => {
    const selected = items.filter(
      (item) => item.selected && (item.importState === 'available' || item.importState === 'update_available'),
    );
    if (selected.length === 0 || importBusy) return;
    setSelectedBatchActive(true);
    try {
      await importItems(selected);
    } finally {
      if (mountedRef.current) setSelectedBatchActive(false);
    }
  }, [importBusy, importItems, items]);

  const openImported = useCallback(
    async (item: ExternalSourceItemView, reportRejection = false) => {
      if (blockingBusy || !['imported', 'update_available'].includes(item.importState) || !item.localBookId) {
        if (reportRejection) throw new Error('지금은 저장된 회차를 열 수 없습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      const novel = await optionsRef.current.getNovel(item.localBookId);
      if (!novel || novel.deletedAt) {
        await refreshLocalProjection();
        optionsRef.current.notify('작품의 보관 상태가 변경되어 목록을 갱신했습니다.', 'warning');
        if (reportRejection) throw new Error('저장된 회차를 찾을 수 없습니다. 회차 목록을 확인해 주세요.');
        return;
      }
      if (
        item.release &&
        optionsRef.current.assets &&
        optionsRef.current.getParagraphPage &&
        sourceReadMode(
          item,
          optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId),
        ) !== 'download' &&
        beginStream(item)
      )
        return;
      if (item.release) {
        const chapters = await optionsRef.current.listChapters(novel.id);
        setLocalSeriesBookId(novel.id);
        setLocalSeriesSeedNovel(novel);
        setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
        setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters, rawItems));
        setLocalSeriesChapters(chapters);
      } else {
        setLocalSeriesBookId(undefined);
        setLocalSeriesSeedNovel(undefined);
        setLocalSeriesSourceId(undefined);
        setLocalSeriesReadingStates(new Map());
        setLocalSeriesChapters([]);
      }
      if (item.release)
        await optionsRef.current.openNovel(novel, {
          documentSectionId: externalItemSectionId(item),
          documentSectionTitle: item.release.title,
        });
      else await optionsRef.current.openNovel(novel);
      setOpen(false);
    },
    [blockingBusy, rawItems, refreshLocalProjection, beginStream, sourceReadMode],
  );

  const cancel = useCallback(() => {
    cancelStreamSaves();
    if (serialImportQueueRef.current) serialImportQueueRef.current.accepting = false;
    setTasks((current) =>
      current.map((task) =>
        task.phase !== 'complete' && task.phase !== 'failed' ? { ...task, phase: 'cancelling' } : task,
      ),
    );
    listAbortRef.current?.abort();
    downloadAbortRef.current?.abort();
    libraryAddAbortRef.current?.abort();
    cancelSubscriptionChecks();
    importRef.current?.cancel();
  }, [cancelStreamSaves, cancelSubscriptionChecks, listAbortRef]);

  const dismissTask = useCallback((taskId: string) => {
    setTasks((current) =>
      current.filter((task) => task.id !== taskId || (task.phase !== 'failed' && task.phase !== 'cancelling')),
    );
  }, []);

  const connect = useCallback(
    async (input?: ExternalSourceConnectionInput) => {
      if (!activeSourceId || busy) return;
      setBusy(true);
      try {
        await optionsRef.current.registry.connectExternalSource(activeSourceId, optionsRef.current.hostContext, input);
        setBrokerRevision((value) => value + 1);
        await loadSourceStart(activeSourceId, 'command-refresh');
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '외부 저장소 연결에 실패했습니다.',
          'danger',
        );
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeSourceId, busy, loadSourceStart],
  );

  const disconnect = useCallback(async () => {
    if (!activeSourceId || busy) return;
    if (!optionsRef.current.confirm('이 기기에서 외부 저장소 연결을 해제할까요? 이미 가져온 책은 유지됩니다.')) return;
    setBusy(true);
    try {
      await optionsRef.current.registry.disconnectExternalSource(activeSourceId, optionsRef.current.hostContext);
      listAbortRef.current?.abort();
      setListFailure(undefined);
      setRawItems([]);
      setDetail(undefined);
      setBrowse(undefined);
      setCatalogBrowse(undefined);
      setCatalogBrowseParentRef(undefined);
      setFilterValues({});
      await refreshLocalProjection();
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setBrokerRevision((value) => value + 1);
      optionsRef.current.notify('외부 저장소 연결을 해제했습니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '외부 저장소 연결을 해제하지 못했습니다.',
        'danger',
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [
    activeSourceId,
    busy,
    listAbortRef,
    refreshLocalProjection,
    setBrowse,
    setCatalogBrowse,
    setCatalogBrowseParentRef,
    setDetail,
    setFilterValues,
    setListFailure,
    setNextCursor,
    setRawItems,
  ]);

  const openItem = useCallback(
    async (item: ExternalSourceItemView) => {
      if (
        !item.navigationRef ||
        (item.kind !== 'folder' && item.kind !== 'work') ||
        blockingBusy ||
        itemNavigationPendingRef.current
      )
        return;
      const connection = activeSourceId
        ? optionsRef.current.registry.getExternalSourceStatus(activeSourceId, optionsRef.current.hostContext)
        : undefined;
      if (
        !activeSourceId ||
        connection?.state !== 'connected' ||
        item.key.connectorId !== activeSourceId ||
        (item.key.accountConnectionId ?? '') !== (connection.accountConnectionId ?? '')
      )
        return;
      itemNavigationPendingRef.current = true;
      cancelResume();
      listAbortRef.current?.abort();
      const navigation = new AbortController();
      listAbortRef.current = navigation;
      setLoading(true);
      setListFailure(undefined);
      try {
        const workPreview =
          item.kind === 'work'
            ? {
                title: item.title,
                author: item.author,
                coverRef: item.coverRef,
                thumbnailUrl: item.thumbnailUrl,
              }
            : undefined;
        setDetail(workPreview);
        setRawItems([]);
        setNextCursor(undefined);
        setBrowse(undefined);
        if (workPreview) setQuery('');
        const next = [...breadcrumbs, { label: item.title, parentRef: item.navigationRef }];
        setBreadcrumbs(next);
        setSelectedKeys(new Set());
        const preference = activeSourceId
          ? await optionsRef.current.state
              .getCatalogPreference(activeSourceId, connection?.accountConnectionId, item.navigationRef)
              .catch(() => undefined)
          : undefined;
        if (!navigationIsCurrent(activeSourceId, connection, navigation)) return;
        if (preference) setFilterValues(preference.filterValues);
        await loadPage(
          {
            parentRef: item.navigationRef,
            browseMode: preference?.browseMode,
            filters: preference?.filters,
          },
          false,
          undefined,
          true,
          false,
          'navigation',
          workPreview ?? null,
        );
      } finally {
        itemNavigationPendingRef.current = false;
      }
    },
    [
      activeSourceId,
      blockingBusy,
      breadcrumbs,
      cancelResume,
      listAbortRef,
      loadPage,
      navigationIsCurrent,
      setBrowse,
      setNextCursor,
      setDetail,
      setFilterValues,
      setListFailure,
      setLoading,
      setRawItems,
    ],
  );

  const openFolder = useCallback(
    async (item: ExternalSourceItemView) => {
      if (item.kind !== 'folder') return;
      await openItem(item);
    },
    [openItem],
  );

  const goBack = useCallback(async () => {
    if (localSeriesBookId) {
      close();
      return;
    }
    if (breadcrumbs.length <= 1 || !activeSourceId) return;
    cancelResume();
    listAbortRef.current?.abort();
    const navigation = new AbortController();
    listAbortRef.current = navigation;
    setLoading(true);
    setDetail(undefined);
    setRawItems([]);
    setBrowse(undefined);
    setNextCursor(undefined);
    setListFailure(undefined);
    const next = breadcrumbs.slice(0, -1);
    setBreadcrumbs(next);
    setSelectedKeys(new Set());
    const parentRef = next.at(-1)?.parentRef;
    const connection = optionsRef.current.registry.getExternalSourceStatus(
      activeSourceId,
      optionsRef.current.hostContext,
    );
    const preference =
      activeSourceId && parentRef
        ? await optionsRef.current.state
            .getCatalogPreference(activeSourceId, connection?.accountConnectionId, parentRef)
            .catch(() => undefined)
        : undefined;
    if (!navigationIsCurrent(activeSourceId, connection, navigation)) return;
    if (preference) setFilterValues(preference.filterValues);
    await loadPage(
      {
        parentRef,
        browseMode: preference?.browseMode,
        filters: preference?.filters,
      },
      false,
    );
  }, [
    activeSourceId,
    breadcrumbs,
    cancelResume,
    close,
    listAbortRef,
    loadPage,
    navigationIsCurrent,
    localSeriesBookId,
    setDetail,
    setRawItems,
    setBrowse,
    setNextCursor,
    setFilterValues,
    setListFailure,
    setLoading,
  ]);

  const setCurrentFolderAsDefault = useCallback(async () => {
    if (!activeSourceId || !currentParentRef || busy) return;
    const connection = optionsRef.current.registry.getExternalSourceStatus(
      activeSourceId,
      optionsRef.current.hostContext,
    );
    if (connection.state !== 'connected') return;
    const path = breadcrumbs
      .slice(1)
      .filter((crumb): crumb is ExternalSourceBreadcrumb & { parentRef: string } => Boolean(crumb.parentRef))
      .map((crumb) => ({ label: crumb.label, parentRef: crumb.parentRef }));
    if (path.length === 0) return;
    const folder: ExternalSourceDefaultFolder = {
      id: externalSourceDefaultFolderId(activeSourceId, connection.accountConnectionId),
      connectorId: activeSourceId,
      accountConnectionId: connection.accountConnectionId,
      parentRef: currentParentRef,
      breadcrumbs: path,
      updatedAt: currentIso(),
      schemaVersion: 1,
    };
    try {
      await optionsRef.current.state.saveDefaultFolder(folder);
      if (!mountedRef.current) return;
      setDefaultFolder(folder);
      optionsRef.current.notify(`${path.at(-1)?.label ?? '현재 폴더'}를 기본 폴더로 설정했습니다.`, 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '기본 폴더를 저장하지 못했습니다.', 'danger');
    }
  }, [activeSourceId, breadcrumbs, busy, currentParentRef]);

  const clearDefaultFolder = useCallback(async () => {
    if (!activeSourceId || busy) return;
    const connection = optionsRef.current.registry.getExternalSourceStatus(
      activeSourceId,
      optionsRef.current.hostContext,
    );
    try {
      await optionsRef.current.state.deleteDefaultFolder(activeSourceId, connection.accountConnectionId);
      if (!mountedRef.current) return;
      setDefaultFolder(undefined);
      optionsRef.current.notify('기본 폴더를 해제했습니다. 다음에는 최상위 폴더부터 엽니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '기본 폴더를 해제하지 못했습니다.', 'danger');
    }
  }, [activeSourceId, busy]);

  const pickItems = useCallback(async () => {
    if (!activeSourceId || busy || !optionsRef.current.registry.pickExternalSource) return;
    if (!optionsRef.current.registry.canPickExternalSource?.(activeSourceId, optionsRef.current.hostContext)) return;
    setBusy(true);
    try {
      const result = await optionsRef.current.registry.pickExternalSource(
        activeSourceId,
        optionsRef.current.hostContext,
      );
      setBrokerRevision((value) => value + 1);
      await refreshLocalProjection();
      await loadPage({ query: query.trim() || undefined }, false, activeSourceId, true, false, 'command-refresh');
      if (result.selectedCount > 0) {
        optionsRef.current.notify(
          result.addedCount > 0
            ? `${result.addedCount}개 Google Drive 파일을 소스에 추가했습니다.`
            : '선택한 Google Drive 파일의 정보를 새로고침했습니다.',
          'success',
        );
      }
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '외부 소스에서 파일을 선택하지 못했습니다.',
        'danger',
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [activeSourceId, busy, loadPage, query, refreshLocalProjection]);

  const removeItem = useCallback(
    async (item: ExternalSourceItemView) => {
      if (!activeSourceId || busy || !optionsRef.current.registry.removeExternalSourceItem) return;
      if (!optionsRef.current.registry.canRemoveExternalSourceItem?.(activeSourceId, optionsRef.current.hostContext)) {
        return;
      }
      if (
        !optionsRef.current.confirm(
          `${item.title}을(를) 이 소스의 선택 목록에서 제거할까요? 이미 라이브러리에 가져온 작품은 유지됩니다.`,
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await optionsRef.current.registry.removeExternalSourceItem(
          activeSourceId,
          optionsRef.current.hostContext,
          item.key,
        );
        setBrokerRevision((value) => value + 1);
        await loadPage({ query: query.trim() || undefined }, false, activeSourceId, true, false, 'command-refresh');
        optionsRef.current.notify('Google Drive 선택 목록에서 파일을 제거했습니다.', 'success');
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '선택 목록에서 파일을 제거하지 못했습니다.',
          'danger',
        );
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeSourceId, busy, loadPage, query],
  );

  const persistLibraryWork = useCallback(
    async (input: {
      readonly sourceId: ExtensionContributionId;
      readonly accountConnectionId?: string;
      readonly navigationRef: string;
      readonly sourceNavigationRef?: string;
      readonly detail: ExternalSourceWorkDetail;
      readonly items: readonly ExternalItemSummary[];
      readonly baselineComplete: boolean;
      readonly signal?: AbortSignal;
    }) => {
      const existing = subscriptions.find(
        (record) =>
          record.connectorId === input.sourceId &&
          (record.accountConnectionId ?? '') === (input.accountConnectionId ?? '') &&
          record.collectionRemoteId === input.navigationRef,
      );
      if (existing) {
        if (!existing.deletedAt) return existing;
        const restored = await changeSourceLibraryTrash(optionsRef.current.state, existing.id, 'restore');
        if (restored && mountedRef.current) replaceSubscription(restored);
        if (restored) return restored;
      }
      const now = currentIso();
      const releaseIds = input.items.filter((item) => item.release).map((item) => item.key.remoteId);
      const resolvedThumbnail = await resolveDetailThumbnail(
        input.detail,
        input.signal ?? new AbortController().signal,
      ).catch(() => undefined);
      const thumbnailUrl = await persistentThumbnailUrl(resolvedThumbnail);
      input.signal?.throwIfAborted();
      if (!mountedRef.current) throw new DOMException('Operation cancelled', 'AbortError');
      const record = {
        id: externalSourceSubscriptionId(input.sourceId, input.accountConnectionId, input.navigationRef),
        connectorId: input.sourceId,
        accountConnectionId: input.accountConnectionId,
        collectionRemoteId: input.navigationRef,
        navigationRef: input.navigationRef,
        sourceNavigationRef: input.sourceNavigationRef,
        title: input.detail.title,
        author: input.detail.author,
        description: input.detail.description,
        thumbnailUrl,
        sourceLabel: input.detail.sourceLabel,
        knownReleaseIds: releaseIds,
        newReleaseIds: [],
        releaseBaselineComplete: input.baselineComplete,
        availableReleaseCount: releaseIds.length,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      } satisfies ExternalSourceSubscriptionRecord;
      await optionsRef.current.state.saveSubscription(record);
      if (mountedRef.current) replaceSubscription(record);
      return record;
    },
    [replaceSubscription, subscriptions, resolveDetailThumbnail],
  );

  useStreamLibraryContinuity({
    item: streaming?.item,
    subscriptions,
    detail,
    sourceLabel: sources.find((source) => source.id === streaming?.item.key.connectorId)?.title,
    items: streamCatalog?.items ?? rawItems,
    complete: streamCatalog?.items ? !streamCatalog.loading : !nextCursor,
    persist: persistLibraryWork,
  });

  const addCurrentWorkToLibrary = useCallback(async () => {
    if (!activeSourceId || !currentParentRef || !detail || busy) return;
    const source = sources.find((candidate) => candidate.id === activeSourceId);
    if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
    try {
      const record = await persistLibraryWork({
        sourceId: activeSourceId,
        accountConnectionId: source.connection.accountConnectionId,
        navigationRef: currentParentRef,
        sourceNavigationRef: breadcrumbs.at(-2)?.parentRef,
        detail,
        items: rawItems,
        baselineComplete: !nextCursor,
        signal: listAbortRef.current?.signal,
      });
      optionsRef.current.notify(
        `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.${
          record.releaseBaselineComplete ? '' : ' 일부 목록만 확인되어 새 회차 판단은 아직 완료되지 않았습니다.'
        }`,
        'success',
      );
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '작품을 라이브러리에 추가하지 못했습니다.',
        'danger',
      );
    }
  }, [
    activeSourceId,
    breadcrumbs,
    busy,
    currentParentRef,
    detail,
    listAbortRef,
    nextCursor,
    persistLibraryWork,
    rawItems,
    sources,
  ]);

  const addWorkToLibrary = useCallback(
    async (item: ExternalSourceItemView) => {
      if (busy || item.kind !== 'work' || !item.navigationRef) return;
      const sourceId = item.key.connectorId as ExtensionContributionId;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
      if (isWorkInLibrary(item)) {
        optionsRef.current.notify('이미 라이브러리에 추가한 작품입니다.');
        return;
      }
      const abort = new AbortController();
      cancelSubscriptionChecks();
      libraryAddAbortRef.current?.abort();
      libraryAddAbortRef.current = abort;
      setBusy(true);
      try {
        const page = await optionsRef.current.registry.listExternalSource(
          sourceId,
          optionsRef.current.hostContext,
          {
            accountConnectionId: source.connection.accountConnectionId,
            parentRef: item.navigationRef,
          },
          abort.signal,
        );
        const record = await persistLibraryWork({
          sourceId,
          accountConnectionId: source.connection.accountConnectionId,
          navigationRef: item.navigationRef,
          sourceNavigationRef: currentParentRef,
          detail: page.detail ?? {
            title: item.title,
            author: item.author,
            description: item.collection?.description ?? item.subtitle,
            thumbnailUrl: item.thumbnailUrl,
            sourceLabel: item.collection?.sourceLabel,
          },
          items: page.items,
          baselineComplete: !page.nextCursor,
          signal: abort.signal,
        });
        optionsRef.current.notify(
          `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.${
            record.releaseBaselineComplete ? '' : ' 일부 목록만 확인되어 새 회차 판단은 아직 완료되지 않았습니다.'
          }`,
          'success',
        );
      } catch (error) {
        if (!isAbort(error)) {
          optionsRef.current.notify(
            error instanceof Error ? error.message : '작품을 라이브러리에 추가하지 못했습니다.',
            'danger',
          );
        }
      } finally {
        if (libraryAddAbortRef.current === abort) libraryAddAbortRef.current = undefined;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, currentParentRef, isWorkInLibrary, persistLibraryWork, sources, cancelSubscriptionChecks],
  );

  const libraryTrashBusy = useRef(false);
  const clearTrashedWorkHistory = useCallback(
    async (work: ExternalSourceSubscriptionRecord) => {
      const identity = {
        connectorId: work.connectorId,
        accountConnectionId: work.accountConnectionId,
        remoteId: work.collectionRemoteId,
      };
      await streamProgress.clearWork(identity);
      await clearSourceWorkHistory({
        state: optionsRef.current.state,
        scope: optionsRef.current.settingsScope,
        work: identity,
        releaseIds: work.knownReleaseIds,
      });
    },
    [streamProgress],
  );
  const changeLibraryTrash = useCallback(
    async (id: string, action: 'trash' | 'restore' | 'purge') => {
      if (busy || libraryTrashBusy.current) return;
      if (action === 'purge' && !optionsRef.current.confirm('이 작품을 휴지통에서 영구 삭제할까요?')) return;
      libraryTrashBusy.current = true;
      libraryAddAbortRef.current?.abort();
      cancelSubscriptionChecks();
      listAbortRef.current?.abort();
      cancelResume();
      setBusy(true);
      try {
        const next = await changeSourceLibraryTrash(optionsRef.current.state, id, action, clearTrashedWorkHistory);
        if (!mountedRef.current) return;
        libraryLoadGeneration.current += 1;
        setSubscriptions((current) => [...current.filter((item) => item.id !== id), ...(next ? [next] : [])]);
        if (action === 'trash') setOpen(false);
        if (action === 'purge') await refreshLocalProjection();
        optionsRef.current.notify(
          action === 'trash'
            ? '휴지통으로 이동했습니다.'
            : action === 'restore'
              ? '작품을 복원했습니다.'
              : '작품을 영구 삭제했습니다.',
          'success',
        );
      } catch (error) {
        optionsRef.current.notify(error instanceof Error ? error.message : '작품을 변경하지 못했습니다.', 'danger');
      } finally {
        libraryTrashBusy.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, cancelSubscriptionChecks, listAbortRef, cancelResume, clearTrashedWorkHistory, refreshLocalProjection],
  );
  const removeLibraryWork = useCallback(
    (work: ExternalSourceSubscriptionRecord) => changeLibraryTrash(work.id, 'trash'),
    [changeLibraryTrash],
  );
  const restoreLibraryWork = useCallback((id: string) => changeLibraryTrash(id, 'restore'), [changeLibraryTrash]);
  const purgeLibraryWork = useCallback((id: string) => changeLibraryTrash(id, 'purge'), [changeLibraryTrash]);
  const batchLibraryTrash = useCallback(
    async (ids: readonly string[], action: 'trash' | 'restore') => {
      if (busy || libraryTrashBusy.current) throw new Error('현재 작업이 끝난 뒤 다시 시도해 주세요.');
      libraryTrashBusy.current = true;
      setBusy(true);
      libraryAddAbortRef.current?.abort();
      cancelSubscriptionChecks();
      listAbortRef.current?.abort();
      cancelResume();
      try {
        return await batchSourceLibraryTrash(optionsRef.current.state, ids, action, (next) => {
          ++libraryLoadGeneration.current;
          if (mountedRef.current)
            setSubscriptions((current) => [...current.filter((work) => work.id !== next.id), next]);
        });
      } finally {
        libraryTrashBusy.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, cancelResume, cancelSubscriptionChecks, listAbortRef],
  );

  const emptyLibraryTrash = useCallback(async () => {
    if (busy || libraryTrashBusy.current) throw new Error('작업이 끝난 뒤 휴지통을 비워 주세요.');
    libraryTrashBusy.current = true;
    setBusy(true);
    try {
      const trashed = (await optionsRef.current.state.listSubscriptions()).filter((work) => work.deletedAt);
      for (const work of trashed)
        await changeSourceLibraryTrash(optionsRef.current.state, work.id, 'purge', clearTrashedWorkHistory);
      return trashed.length;
    } finally {
      libraryTrashBusy.current = false;
      if (mountedRef.current) setBusy(false);
      await refreshLocalProjection();
    }
  }, [busy, clearTrashedWorkHistory, refreshLocalProjection]);

  const subscribeCurrentWork = addCurrentWorkToLibrary;

  const unsubscribeCurrentWork = useCallback(async () => {
    if (activeSubscription) await removeLibraryWork(activeSubscription);
  }, [activeSubscription, removeLibraryWork]);

  const acknowledgeNewReleases = useCallback(async () => {
    if (!activeSubscription || activeSubscription.newReleaseIds.length === 0 || busy) return;
    const next = {
      ...activeSubscription,
      newReleaseIds: [],
      updatedAt: currentIso(),
    } satisfies ExternalSourceSubscriptionRecord;
    try {
      await optionsRef.current.state.saveSubscription(next);
      if (!mountedRef.current) return;
      replaceSubscription(next);
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '새 회차 상태를 저장하지 못했습니다.',
        'danger',
      );
    }
  }, [activeSubscription, busy, replaceSubscription]);

  const selectNewReleases = useCallback(() => {
    if (!activeSubscription || busy) return;
    const newIds = new Set(activeSubscription.newReleaseIds);
    setSelectedKeys(
      new Set(
        items
          .filter(
            (item) =>
              newIds.has(item.key.remoteId) &&
              item.kind !== 'folder' &&
              item.importState !== 'unsupported' &&
              item.importState !== 'imported',
          )
          .map((item) => externalItemKeyId(item.key)),
      ),
    );
  }, [activeSubscription, busy, items]);

  const openSubscription = useCallback(
    async (subscription: ExternalSourceSubscriptionRecord) => {
      if (subscription.deletedAt) return;
      directStreamEntry.current = false;
      cancelResume();
      const sourceId = subscription.connectorId as ExtensionContributionId;
      if (blockingBusy || (importBusy && sourceId !== activeSourceId)) return;
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
      if (connection.state !== 'connected' || connection.accountConnectionId !== subscription.accountConnectionId) {
        optionsRef.current.notify('작품 소스에 다시 연결한 뒤 회차를 확인할 수 있습니다.', 'warning');
        return;
      }
      listAbortRef.current?.abort();
      const navigation = new AbortController();
      listAbortRef.current = navigation;
      setLoading(true);
      const workPreview = {
        title: subscription.title,
        author: subscription.author,
        description: subscription.description,
        thumbnailUrl: subscription.thumbnailUrl,
        sourceLabel: subscription.sourceLabel,
      };
      setDetail(workPreview);
      setRawItems([]);
      setNextCursor(undefined);
      setListFailure(undefined);
      setCatalogLoading(false);
      setBrowse(undefined);
      clearStream();
      localSeriesPageSeedRef.current = undefined;
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setActiveSourceId(sourceId);
      setOpen(true);
      setQuery('');
      setSelectedKeys(new Set());
      setBreadcrumbs([
        { label: '최상위 폴더' },
        ...(subscription.sourceNavigationRef
          ? [{ label: subscription.sourceLabel ?? 'Mihon 소스', parentRef: subscription.sourceNavigationRef }]
          : []),
        { label: subscription.title, parentRef: subscription.navigationRef },
      ]);
      await refreshLocalProjection();
      if (!navigationIsCurrent(sourceId, connection, navigation)) return;
      await loadPage(
        { parentRef: subscription.navigationRef },
        false,
        sourceId,
        true,
        false,
        'navigation',
        workPreview,
      );
    },
    [
      activeSourceId,
      blockingBusy,
      cancelResume,
      clearStream,
      importBusy,
      listAbortRef,
      loadPage,
      navigationIsCurrent,
      localSeriesPageSeedRef,
      refreshLocalProjection,
      setBrowse,
      setCatalogLoading,
      setDetail,
      setListFailure,
      setLoading,
      setNextCursor,
      setRawItems,
    ],
  );

  const continueLibraryWork = useCallback(
    async (workId: string) => {
      if (blockingBusy || importBusy) return;
      cancelResume();
      let abort = startResume();
      const current = optionsRef.current;
      try {
        await current.waitForReadingHistory?.();
        const work = (await current.state.listSubscriptions?.())?.find((candidate) => candidate.id === workId);
        abort.signal.throwIfAborted();
        if (!work || work.deletedAt || !mountedRef.current) return;
        const sourceId = work.connectorId as ExtensionContributionId;
        const connection = current.registry.getExternalSourceStatus(sourceId, current.hostContext);
        if (connection.state !== 'connected' || connection.accountConnectionId !== work.accountConnectionId) {
          throw new Error('작품 소스에 다시 연결한 뒤 읽을 수 있습니다.');
        }
        const port = current.registry.getSourceStream?.(sourceId);
        if (!port || isTextStream(port)) {
          const opening = openSubscription(work);
          abort = startResume();
          await opening;
          abort.signal.throwIfAborted();
        }
        await reconcileStreamProgress();
        const preferences = await recoverSourceStreamVisits(current.settingsScope, current.state);
        abort.signal.throwIfAborted();
        if (!mountedRef.current) return;
        const visit = latestSourceVisits(preferences).get(
          externalItemKeyId({
            connectorId: sourceId,
            accountConnectionId: work.accountConnectionId,
            remoteId: work.collectionRemoteId,
          }),
        );
        if (visit) {
          await resumeSourceVisit(visit);
          return;
        }
        if (!current.registry.getSourceStream?.(sourceId)) throw new Error('이 소스에서 스트리밍을 지원하지 않습니다.');
        const input = { parentRef: work.navigationRef, accountConnectionId: connection.accountConnectionId };
        const id = cachePageId(
          sourceId,
          connection.accountConnectionId,
          input,
          current.settingsScope,
          connection.connectionGeneration,
        );
        const cached = await current.state.getCachePage(id).catch(() => undefined);
        const completeCache =
          cached?.completeSeries &&
          !cached.nextCursor &&
          Date.parse(cached.fetchedAt) + sourceCachePolicy(input, false, preferenceScope).keep > Date.now();

        const read = (cursor?: string) =>
          current.registry.listExternalSource(sourceId, current.hostContext, { ...input, cursor }, abort.signal);
        const catalog = completeCache ? cached : await completeSeriesCatalog(await read(), read, abort.signal);
        abort.signal.throwIfAborted();
        if (!mountedRef.current) return;
        const first = filterAndSortReleases(
          catalog.items
            .filter((item) => item.release)
            .map((item) => ({
              ...item,
              selected: false,
              importState: 'available' as const,
            })),
          '',
          'all',
          'asc',
        )[0];
        if (!first) throw new Error('읽을 수 있는 회차가 없습니다.');
        const latestConnection = current.registry.getExternalSourceStatus(sourceId, current.hostContext);
        if (
          latestConnection.state !== 'connected' ||
          latestConnection.accountConnectionId !== work.accountConnectionId ||
          latestConnection.connectionGeneration !== connection.connectionGeneration
        ) {
          throw new Error('소스 연결이 변경되었습니다. 다시 열어 주세요.');
        }
        if (!completeCache) {
          await saveSourceCache(current.state, {
            ...storedSourcePage(id, sourceId, input, catalog, current.settingsScope),
            completeSeries: true,
          });
          abort.signal.throwIfAborted();
        }
        if (preferTextLibrary(first, current.registry.getSourceStream?.(sourceId)))
          await libraryOpenRef.current?.(first);
        else beginStream(first);
      } catch (error) {
        if (!abort.signal.aborted)
          current.notify(error instanceof Error ? error.message : '회차를 열지 못했습니다.', 'warning');
      }
    },
    [
      blockingBusy,
      importBusy,
      cancelResume,
      startResume,
      openSubscription,
      reconcileStreamProgress,
      beginStream,
      resumeSourceVisit,
      preferTextLibrary,
      preferenceScope,
    ],
  );

  const canPickItems = Boolean(
    activeSourceId && options.registry.canPickExternalSource?.(activeSourceId, options.hostContext),
  );
  const canRemoveItems = Boolean(
    activeSourceId && options.registry.canRemoveExternalSourceItem?.(activeSourceId, options.hostContext),
  );
  const canSubscribeCurrentWork = Boolean(
    activeSourceId &&
    currentParentRef &&
    detail &&
    sources.find((source) => source.id === activeSourceId)?.supportsSubscriptions &&
    sources.find((source) => source.id === activeSourceId)?.connection.state === 'connected',
  );
  const [readingHistoryRevision, setReadingHistoryRevision] = useState(0);
  const historyItem = streaming?.item ?? currentWorkItem;
  const workIdentity = historyItem?.collection
    ? { ...historyItem.key, remoteId: historyItem.collection.remoteId }
    : activeSubscription
      ? {
          connectorId: activeSubscription.connectorId,
          accountConnectionId: activeSubscription.accountConnectionId,
          remoteId: activeSubscription.collectionRemoteId,
        }
      : activeSourceId && currentParentRef
        ? {
            connectorId: activeSourceId,
            accountConnectionId: sources.find((source) => source.id === activeSourceId)?.connection.accountConnectionId,
            remoteId: currentParentRef,
          }
        : undefined;
  const clearWorkHistory = async (work: ExternalItemKey) => {
    await streamProgress.clearWork(work);
    const subscription = subscriptions.find((p) =>
      belongsToSourceWork(
        { connectorId: p.connectorId, accountConnectionId: p.accountConnectionId, remoteId: p.collectionRemoteId },
        p.collectionRemoteId,
        work,
      ),
    );
    await clearSourceWorkHistory({
      state: optionsRef.current.state,
      scope: optionsRef.current.settingsScope,
      work,
      releaseIds: [
        ...(subscription?.knownReleaseIds ?? []),
        ...rawItems
          .filter((item) => belongsToSourceWork(item.key, item.collection?.remoteId, work))
          .map((item) => item.key.remoteId),
      ],
    });
  };
  const clearBookSourceHistory = async (novel: Novel) => {
    const allLinks = await optionsRef.current.state.listLinks();
    const works = new Map<string, ExternalItemKey>();
    for (const link of allLinks) {
      if (link.localBookId !== novel.id || !link.collectionRemoteId) continue;
      const work = { ...link.source, remoteId: link.collectionRemoteId };
      works.set(externalItemKeyId(work), work);
    }
    if (!works.size) return;
    for (const work of works.values()) await clearWorkHistory(work);
    setReadingHistoryRevision((value) => value + 1);
    await refreshLocalProjection();
  };
  const resetCurrentWorkHistory = async () => {
    if (busy || importBusy || blockingBusy || streaming || (!workIdentity && !localSeriesBookId)) return;
    if (
      !optionsRef.current.confirm(
        '읽은 기록을 초기화할까요?\n\n읽음 표시, 이어보기 위치와 누적 독서 시간이 지워집니다. 본문, 북마크와 메모는 유지됩니다.',
      )
    )
      return;
    setBusy(true);
    try {
      if (workIdentity) await streamProgress.clearWork(workIdentity);
      const bookIds = new Set(
        links
          .filter(
            (link) =>
              !link.pendingImport &&
              novelById.has(link.localBookId) &&
              !novelById.get(link.localBookId)?.deletedAt &&
              workIdentity &&
              belongsToSourceWork(link.source, link.collectionRemoteId, workIdentity),
          )
          .map((link) => link.localBookId),
      );
      if (localSeriesBookId) bookIds.add(localSeriesBookId);
      for (const bookId of bookIds) {
        if (!optionsRef.current.clearReadingHistory) throw new Error('읽은 기록 초기화를 사용할 수 없습니다.');
        await optionsRef.current.clearReadingHistory(bookId);
      }
      if (workIdentity) await clearWorkHistory(workIdentity);
      setReadingHistoryRevision((value) => value + 1);
      await optionsRef.current.onLibraryChanged();
      await refreshLocalProjection();
      if (localSeriesBookId) {
        const novel = await optionsRef.current.getNovel(localSeriesBookId);
        if (novel) await showLocalSeries(novel, 'command-refresh');
      }
      optionsRef.current.notify('읽은 기록을 초기화했습니다.', 'success');
    } catch {
      optionsRef.current.notify('읽은 기록을 모두 초기화하지 못했습니다. 다시 시도해 주세요.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const localSeriesNovel = localSeriesBookId
    ? (novels.find((novel) => novel.id === localSeriesBookId) ?? localSeriesSeedNovel)
    : undefined;

  const openDiscovery = async (
    sourceId: ExtensionContributionId,
    input: ExternalSourceListInput,
    title?: string,
    item?: ExternalItemSummary,
  ) => {
    if (blockingBusy || (importBusy && sourceId !== activeSourceId)) return;
    cancelResume();
    const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
    const workPreview =
      item?.kind === 'work' &&
      item.navigationRef &&
      item.navigationRef === input.parentRef &&
      item.key.connectorId === sourceId &&
      (item.key.accountConnectionId ?? '') === (connection.accountConnectionId ?? '')
        ? { title: item.title, author: item.author, coverRef: item.coverRef, thumbnailUrl: item.thumbnailUrl }
        : undefined;
    setLocalSeriesBookId(undefined);
    setLocalSeriesSeedNovel(undefined);
    setLocalSeriesSourceId(undefined);
    setLocalSeriesReadingStates(new Map());
    setLocalSeriesChapters([]);
    localSeriesPageSeedRef.current = undefined;
    setActiveSourceId(sourceId);
    setOpen(true);
    setQuery(input.query ?? '');
    setSelectedKeys(new Set());
    setFilterValues({});
    setDetail(workPreview);
    setRawItems([]);
    setNextCursor(undefined);
    setBrowse(undefined);
    setCatalogBrowse(undefined);
    setCatalogBrowseParentRef(undefined);
    setDefaultFolder(undefined);
    setBreadcrumbs([
      { label: '최상위 폴더' },
      ...(input.parentRef ? [{ label: title ?? '작품 목록', parentRef: input.parentRef }] : []),
    ]);
    await loadPage(input, false, sourceId, true, false, 'navigation', workPreview ?? null);
  };

  const captureNavigation = (): ExternalSourceNavigationSnapshot => {
    const connection = activeSourceId
      ? optionsRef.current.registry.getExternalSourceStatus(activeSourceId, optionsRef.current.hostContext)
      : undefined;
    return {
      sourceId: activeSourceId,
      accountId: connection?.accountConnectionId,
      generation: connection?.connectionGeneration,
      items: catalogItems,
      query,
      nextCursor,
      detail: catalogDetail,
      browse,
      filters: filterValues,
      breadcrumbs,
      selected: selectedKeys,
      localBookId: localSeriesBookId,
      localSourceId: localSeriesSourceId,
      defaultFolder,
      stale,
    };
  };
  const restoreNavigation = async (snapshot: ExternalSourceNavigationSnapshot) => {
    listAbortRef.current?.abort();
    const navigation = new AbortController();
    listAbortRef.current = navigation;
    if (snapshot.sourceId) {
      const current = optionsRef.current.registry.getExternalSourceStatus(
        snapshot.sourceId,
        optionsRef.current.hostContext,
      );
      if (current.accountConnectionId !== snapshot.accountId || current.connectionGeneration !== snapshot.generation) {
        close();
        return;
      }
    }
    setCatalogLoading(false);
    setLoading(false);
    setListFailure(undefined);
    setActiveSourceId(snapshot.sourceId);
    setRawItems(snapshot.items);
    setQuery(snapshot.query);
    setNextCursor(snapshot.nextCursor);
    setDetail(snapshot.detail);
    setBrowse(snapshot.browse);
    setFilterValues(snapshot.filters);
    setBreadcrumbs(snapshot.breadcrumbs);
    setSelectedKeys(snapshot.selected);
    setDefaultFolder(snapshot.defaultFolder);
    setStale(snapshot.stale);
    setLocalSeriesBookId(snapshot.localBookId);
    setLocalSeriesSourceId(snapshot.localSourceId);
    setLocalSeriesSeedNovel(undefined);
    setLocalSeriesChapters([]);
    setLocalSeriesReadingStates(new Map());
    localSeriesPageSeedRef.current = undefined;
    openRef.current = true;
    setOpen(true);
    if (snapshot.localBookId) {
      const [novel, chapters] = await Promise.all([
        optionsRef.current.getNovel(snapshot.localBookId),
        optionsRef.current.listChapters(snapshot.localBookId),
      ]);
      if (navigation.signal.aborted) return;
      if (!novel || novel.deletedAt) {
        close();
        return;
      }
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesChapters(chapters);
      setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters, snapshot.items));
      localSeriesPageSeedRef.current = {
        sourceId: snapshot.sourceId,
        accountConnectionId: snapshot.accountId,
        parentRef: snapshot.breadcrumbs.at(-1)?.parentRef,
        items: snapshot.items,
        remoteItems: snapshot.items,
        detail: snapshot.detail ?? localSeriesDetail(novel),
      };
    }
  };

  return {
    openDiscovery,
    downloadRetention,
    renameRelease: options.state.saveReleasePreferences ? renameRelease : undefined,
    setReleasesRead: options.state.saveReleasePreferences ? setReleasesRead : undefined,
    markPreviousReleasesRead: options.state.saveReleasePreferences ? markPreviousReleasesRead : undefined,
    recoverableDownloads,
    resumeDownloadQueue,
    discardDownloadQueue,
    autoDownloadNext: automaticDownload.enabled,
    autoDownloadNextCount: automaticDownload.count,
    setAutoDownloadNextCount: automaticDownload.setCount,
    setAutoDownloadNext: automaticDownload.setEnabled,
    captureNavigation,
    restoreNavigation,
    open,
    loading,
    busy,
    blockingBusy,
    catalogLoading,
    catalogPreparing: Boolean(
      catalogLoading && localSeriesPageSeedRef.current && !localSeriesPageSeedRef.current.remoteItems.length,
    ),
    importBusy,
    selectedBatchActive,
    deletingDownloads,
    tasks,
    linkedSeriesBookIds,
    sources,
    activeSourceId,
    items,
    query,
    nextCursor,
    stale,
    listError: listFailure
      ? {
          message: listFailure.message,
          retry: async () => {
            await loadPage(listFailure.input, listFailure.append, listFailure.sourceId, true, true);
          },
        }
      : undefined,
    detail:
      detail && activeSubscription?.titleOverride && !localSeriesNovel
        ? { ...detail, title: activeSubscription.titleOverride }
        : detail,
    localSeriesNovel,
    localSeriesSourceId,
    browse,
    catalogBrowse,
    filterValues,
    breadcrumbs,
    currentFolderIsDefault: Boolean(currentParentRef && defaultFolder?.parentRef === currentParentRef),
    currentLocationCanBeDefault: Boolean(
      currentParentRef && !detail && sources.find((source) => source.id === activeSourceId)?.kind === 'cloud_file',
    ),
    canPickItems,
    canRemoveItems,
    progress,
    subscriptions,
    libraryWorks,
    libraryBootstrap,
    retryLibrary: refreshLocalProjection,
    batchLibraryTrash,
    restoreLibraryWork,
    purgeLibraryWork,
    emptyLibraryTrash,
    sourceWorkProgress,
    sourceVisits,
    sourceHistoryScope: options.settingsScope,
    currentWorkVisit,
    activeSubscription,
    checkingSubscriptions,
    canSubscribeCurrentWork,
    canQueueItem,
    isWorkInLibrary,
    addWorkToLibrary,
    addCurrentWorkToLibrary,
    removeLibraryWork,
    show,
    showLocalSeries,
    resolveSourceSeriesBook,
    readingHistoryLoading,
    continueSourceReading,
    canResumeCurrentWork,
    resumeCurrentWork,
    close,
    selectSource,
    setQuery,
    search,
    setBrowseMode,
    openCatalogBrowse,
    setFilterValue,
    applyFilters,
    resetFilters,
    refresh,
    loadMore,
    toggleItem,
    selectAllSupported,
    importItem,
    importAndOpen,
    openingItemKey: libraryOpen.openingItemKey,
    libraryReader,
    streaming,
    streamCatalog,
    resetCurrentWorkHistory,
    clearBookSourceHistory,
    readingHistoryRevision,
    workReadingSessionId: workIdentity ? sourceWorkSessionId(options.settingsScope, workIdentity) : undefined,
    streamingBookId: streaming
      ? links.find(
          (link) =>
            !link.pendingImport &&
            externalItemKeyId(link.source) === externalItemKeyId(streaming.item.key) &&
            novels.some((novel) => novel.id === link.localBookId && !novel.deletedAt),
        )?.localBookId
      : undefined,
    closeStream: () => {
      if (directStreamEntry.current) {
        directStreamEntry.current = false;
        setOpen(false);
      }
      setReadingHistoryLoading(true);
      clearStream();
      void streamProgress
        .reconcile()
        .then(async () => {
          await optionsRef.current.onLibraryChanged();
          await refreshLocalProjection();
        })
        .catch(() => optionsRef.current.notify('읽던 위치를 새로고침하지 못했습니다.', 'warning'))
        .finally(() => {
          if (mountedRef.current) setReadingHistoryLoading(false);
        });
    },
    openStreamItem:
      options.assets && options.getParagraphPage
        ? async (item) => {
            if (!item.release || !beginStream(item, true)) throw new Error('이 회차를 바로 열 수 없습니다.');
          }
        : undefined,
    saveTextStreamPosition: (item, position) => streamProgress.record(item, { kind: 'text', ...position }),
    saveStreamPosition: (item, page, count, fraction) =>
      streamProgress.record(item, { kind: 'image', page, count, fraction }),
    saveStream,
    canStreamItem: (item) =>
      sourceReadMode(
        item,
        optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId),
      ) !== 'download' &&
      Boolean(optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId)),
    importSelected,
    deleteDownloads,
    openImported,
    cancel,
    dismissTask,
    connect,
    disconnect,
    openItem,
    openFolder,
    goBack,
    setCurrentFolderAsDefault,
    clearDefaultFolder,
    pickItems,
    removeItem,
    subscribeCurrentWork,
    unsubscribeCurrentWork,
    acknowledgeNewReleases,
    selectNewReleases,
    checkSubscriptions,
    openSubscription,
    updateLibraryMetadata: async (id, patch) => {
      const next = await updateSourceLibraryMetadata(optionsRef.current.state, id, patch);
      ++libraryLoadGeneration.current;
      if (mountedRef.current) replaceSubscription(next);
    },
    continueLibraryWork,
  };
}
