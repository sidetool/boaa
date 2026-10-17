import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import {
  externalItemKeyId,
  type ExternalItemSummary,
  type ExternalSourceListInput,
  type ExternalSourceWorkDetail,
  type ExternalSourceBrowseState,
  type ExternalSourceConnectionStatus,
  type ExternalCatalogCachePage,
} from '../../external-sources/contracts';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
import type { useSourceSubscriptionRefresh } from './use-source-subscription-refresh';
import { sourceCachePolicy, transientSourceFailure } from '../../external-sources/cache-policy';
import { storedSourcePage, saveSourceCache, cachePageId } from '../../external-sources/cached-page';
import { TextServerRequestError } from '../../external-sources/text-server/text-server-errors';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { completeSeriesCatalog } from './complete-series-catalog';
import { mergeSeriesCatalogItems } from './series-catalog-pagination';
import { sourceCatalogSetters, type SourceCatalogState } from './source-catalog-state';
import { defaultFilterValues, queryFingerprint } from './source-catalog-query-values';
export interface SourceCatalogSeed {
  sourceId?: string;
  accountConnectionId?: string;
  parentRef?: string;
  items: readonly ExternalItemSummary[];
  remoteItems: readonly ExternalItemSummary[];
  detail: ExternalSourceWorkDetail;
}
export interface SourceCatalogQueryPort extends Pick<
  UseExternalSourceControllerOptions,
  'hostContext' | 'settingsScope' | 'notify'
> {
  registry: Pick<UseExternalSourceControllerOptions['registry'], 'getExternalSourceStatus' | 'listExternalSource'>;
  state: Pick<UseExternalSourceControllerOptions['state'], 'getCachePage' | 'saveCachePage'>;
  reconcile: ReturnType<typeof useSourceSubscriptionRefresh>['reconcileSubscriptionPage'];
  retainSelection: (visibleKeys: ReadonlySet<string>) => void;
}
export interface SourceCatalogRequest {
  port: SourceCatalogQueryPort;
  sourceId: ExtensionContributionId;
  connection: ExternalSourceConnectionStatus;
  input: ExternalSourceListInput;
  append: boolean;
  notifyFailure: boolean;
  forceRefresh: boolean;
  abort: AbortController;
  connectionIsCurrent: () => boolean;
  ownsRequest: () => boolean;
  seedRef: MutableRefObject<SourceCatalogSeed | undefined>;
  state: SourceCatalogState;
  update: Dispatch<SetStateAction<SourceCatalogState>>;
}
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';
/** Fetch/cache/revalidate one catalog request. Every continuation belongs to its captured source connection. */
export async function runSourceCatalogQuery(request: SourceCatalogRequest): Promise<boolean | undefined> {
  const {
    port,
    sourceId,
    connection,
    input,
    append,
    notifyFailure,
    forceRefresh,
    abort,
    connectionIsCurrent,
    ownsRequest,
    seedRef,
    state,
    update,
  } = request;
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
  } = sourceCatalogSetters(update);
  setListFailure(undefined);
  const seed = seedRef.current;
  const localSeed =
    seed?.sourceId === sourceId &&
    (seed.accountConnectionId ?? '') === (connection.accountConnectionId ?? '') &&
    seed.parentRef === input.parentRef &&
    !input.query &&
    !input.filters?.length
      ? seed
      : undefined;
  if (!localSeed) seedRef.current = undefined;
  if (connection.state !== 'connected') {
    setRawItems(localSeed?.items ?? []);
    setDetail(localSeed?.detail);
    setNextCursor(undefined);
    setStale(false);
    return false;
  }
  if (append || localSeed) {
    setLoading(false);
    setCatalogLoading(true);
  } else {
    setLoading(true);
    setCatalogLoading(false);
  }
  const normalizedInput: ExternalSourceListInput = {
    ...input,
    ...(forceRefresh ? { cacheMode: 'reload' as const } : {}),
    accountConnectionId: connection.accountConnectionId,
  };
  const id = cachePageId(
    sourceId,
    connection.accountConnectionId,
    normalizedInput,
    port.settingsScope,
    connection.connectionGeneration,
  );
  let cached: ExternalCatalogCachePage | undefined;
  try {
    cached = await port.state.getCachePage(id).catch(() => undefined);
    if (cached && Date.parse(cached.fetchedAt) + sourceCachePolicy(input).keep <= Date.now()) cached = undefined;
    const snapshot = !append ? cached : undefined;
    if (!connectionIsCurrent()) {
      setLoading(false);
      setCatalogLoading(false);
      return;
    }
    const publish = (page: {
      items: readonly ExternalItemSummary[];
      detail?: ExternalSourceWorkDetail;
      nextCursor?: string;
      browse?: ExternalSourceBrowseState;
    }) => {
      if (localSeed) {
        localSeed.remoteItems = page.items;
        setRawItems(mergeSeriesCatalogItems(localSeed.items, page.items));
      } else setRawItems([...page.items]);
      setDetail(page.detail ?? localSeed?.detail);
      setNextCursor(page.nextCursor);
      setBrowse(page.browse);
      if (page.browse) {
        setCatalogBrowse(page.browse);
        setCatalogBrowseParentRef(normalizedInput.parentRef);
        setFilterValues(
          normalizedInput.filters?.length
            ? Object.fromEntries(
                (page.browse.filters ?? []).flatMap((definition) => {
                  if (!('defaultValue' in definition)) return [];
                  const change = normalizedInput.filters?.find(
                    (v) => v.position === definition.position && v.groupPosition === definition.groupPosition,
                  );
                  return [[definition.id, change?.value ?? definition.defaultValue]];
                }),
              )
            : defaultFilterValues(page.browse.filters),
        );
      }
    };
    if (snapshot) {
      publish(snapshot);
      setLoading(false);
      setStale(Date.parse(snapshot.expiresAt) <= Date.now());
      if (
        !forceRefresh &&
        (!snapshot.items.some((item) => item.release && item.collection) || snapshot.completeSeries === true) &&
        Date.parse(snapshot.expiresAt) > Date.now() &&
        Date.parse(snapshot.fetchedAt) + sourceCachePolicy(input).fresh > Date.now()
      ) {
        setCatalogLoading(false);
        return true;
      }
      setCatalogLoading(true);
    } else if (!append) setRawItems(localSeed?.items ?? []);
    let page = await port.registry.listExternalSource(sourceId, port.hostContext, normalizedInput, abort.signal);
    if (!connectionIsCurrent()) return;
    const series =
      !normalizedInput.cursor &&
      !page.browse &&
      Boolean(
        page.detail ||
        page.items.some((item) => item.release && item.collection?.remoteId === normalizedInput.parentRef),
      );
    if (series) {
      if (!snapshot) setDetail(page.detail ?? localSeed?.detail);
      page = await completeSeriesCatalog(
        page,
        (cursor) => {
          if (!connectionIsCurrent()) throw new DOMException('Catalog connection changed', 'AbortError');
          return port.registry.listExternalSource(
            sourceId,
            port.hostContext,
            { ...normalizedInput, cacheMode: undefined, cursor },
            abort.signal,
          );
        },
        abort.signal,
      );
    }
    if (!connectionIsCurrent()) return;
    if (snapshot && series) {
      setStale(page.cache?.stale === true);
      const nextStored = storedSourcePage(id, sourceId, normalizedInput, page, port.settingsScope);
      publish(page);
      if (!connectionIsCurrent()) return;
      await saveSourceCache(port.state, {
        ...nextStored,
        completeSeries: true,
      });
      if (!connectionIsCurrent()) return;
      await port
        .reconcile(sourceId, connection.accountConnectionId, normalizedInput.parentRef, page, true, connectionIsCurrent)
        .catch(() => undefined);
      return true;
    }
    if (localSeed) {
      localSeed.remoteItems = mergeSeriesCatalogItems([], [...(append ? localSeed.remoteItems : []), ...page.items]);
      setRawItems(mergeSeriesCatalogItems(localSeed.items, localSeed.remoteItems));
    } else {
      setRawItems((current) => mergeSeriesCatalogItems([], [...(append ? current : []), ...page.items]));
    }
    if (!append) setDetail(page.detail ?? localSeed?.detail);
    if (!append) {
      setBrowse(page.browse);
      if (page.browse) {
        setCatalogBrowse(page.browse);
        setCatalogBrowseParentRef(normalizedInput.parentRef);
      }
      if (page.browse?.filters) {
        setFilterValues((current) =>
          normalizedInput.filters?.length
            ? Object.fromEntries(
                (page.browse?.filters ?? []).flatMap((definition) => {
                  if (!('defaultValue' in definition)) return [];
                  const change = normalizedInput.filters?.find(
                    (value) =>
                      value.position === definition.position && value.groupPosition === definition.groupPosition,
                  );
                  return [[definition.id, change?.value ?? definition.defaultValue]];
                }),
              )
            : Object.keys(current).length > 0
              ? current
              : defaultFilterValues(page.browse?.filters),
        );
      }
    }
    const visibleKeys = new Set(
      [...(localSeed?.items ?? []), ...(append ? state.catalogItems : []), ...page.items].map((item) =>
        externalItemKeyId(item.key),
      ),
    );
    port.retainSelection(visibleKeys);
    setNextCursor(page.nextCursor);
    setStale(page.cache?.stale === true);
    await port
      .reconcile(
        sourceId,
        connection.accountConnectionId,
        normalizedInput.parentRef,
        page,
        !normalizedInput.cursor && !page.nextCursor,
        connectionIsCurrent,
      )
      .catch(() => undefined);
    if (!connectionIsCurrent()) return;
    await saveSourceCache(port.state, {
      ...storedSourcePage(id, sourceId, normalizedInput, page, port.settingsScope),
      id,
      connectorId: sourceId,
      accountConnectionId: connection.accountConnectionId,
      queryFingerprint: queryFingerprint(normalizedInput),
      cursor: normalizedInput.cursor,
      nextCursor: page.nextCursor,
      completeSeries: series || undefined,
      browse: page.browse,

      schemaVersion: 1,
    });
    if (!connectionIsCurrent()) return;
    return true;
  } catch (error) {
    if (isAbort(error) || !connectionIsCurrent()) return undefined;
    cached ??= await port.state.getCachePage(id).catch(() => undefined);
    if (
      !transientSourceFailure(error) ||
      (cached && Date.parse(cached.fetchedAt) + sourceCachePolicy(input).keep <= Date.now())
    )
      cached = undefined;
    if (!connectionIsCurrent()) return undefined;
    const failureMessage =
      packageOperationMessage(error) ??
      (error instanceof TextServerRequestError
        ? error.message
        : '외부 저장소 목록을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
    const resetCursor =
      cached || (error instanceof Error && /source_catalog_changed|목록이 갱신되었습니다/.test(error.message));
    setListFailure({
      message: cached ? `${failureMessage} 마지막으로 받아 둔 목록을 표시합니다.` : failureMessage,
      // Cached pages are already visible. Refresh from the start instead of appending them twice.
      input: resetCursor ? { ...input, cursor: undefined } : input,
      append: resetCursor ? false : append,
      sourceId,
    });
    if (cached) {
      if (localSeed) {
        localSeed.remoteItems = mergeSeriesCatalogItems(
          [],
          [...(append ? localSeed.remoteItems : []), ...cached.items],
        );
        setRawItems(mergeSeriesCatalogItems(localSeed.items, localSeed.remoteItems));
      } else {
        const cachedItems = cached.items;
        setRawItems((current) => mergeSeriesCatalogItems([], [...(append ? current : []), ...cachedItems]));
      }
      if (!append) setDetail(cached.detail ?? localSeed?.detail);
      if (!append) {
        setBrowse(cached.browse);
        if (cached.browse) {
          setCatalogBrowse(cached.browse);
          setCatalogBrowseParentRef(normalizedInput.parentRef);
        }
        setFilterValues(defaultFilterValues(cached.browse?.filters));
      }
      setNextCursor(cached.nextCursor);
      setStale(true);
      port.notify(
        error instanceof TextServerRequestError
          ? `${error.message} 마지막으로 받아 둔 목록을 표시합니다.`
          : '외부 저장소를 새로고치지 못해 마지막 목록을 표시합니다.',
        'warning',
      );
      return true;
    } else {
      if (!append) {
        setRawItems(localSeed?.items ?? []);
        setDetail(localSeed?.detail);
        setBrowse(undefined);
        setNextCursor(undefined);
        setStale(false);
      }
      if (notifyFailure) {
        port.notify(failureMessage, 'danger');
      }
      return false;
    }
  } finally {
    if (ownsRequest()) {
      setLoading(false);
      setCatalogLoading(false);
    }
  }
}
