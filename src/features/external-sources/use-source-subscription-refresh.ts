import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExternalItemPage,
  ExternalItemSummary,
  ExternalSourceWorkDetail,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import {
  externalSourceSubscriptionId,
  type ExternalSourceLocalState,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { ExternalSourceView } from './external-source-controller-contract';
import {
  collectSubscriptionReleasePages,
  MAX_SUBSCRIPTION_CHECK_TOTAL_PAGES,
  reconcileSubscriptionReleaseIds,
} from './series-catalog-pagination';
import { persistentThumbnailUrl } from './source-persistent-thumbnail';

interface SubscriptionRefreshPort {
  readonly registry: Pick<ExternalSourceRegistryPort, 'getExternalSourceStatus' | 'listExternalSource'>;
  readonly state: Pick<ExternalSourceLocalState, 'listSubscriptions' | 'saveSubscription'>;
  readonly hostContext: TrustedExternalSourceHostContext;
  readonly source?: Pick<ExternalSourceView, 'id' | 'supportsSubscriptions' | 'connection'>;
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
  readonly busy: boolean;
  readonly foreground: boolean;
  onRecord(record: ExternalSourceSubscriptionRecord): void;
  onSnapshot(records: ExternalSourceSubscriptionRecord[]): void;
  notify(message: string, tone?: ToastTone): void;
}

const currentIso = () => new Date().toISOString();
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** Owns subscription refresh sessions, page budgets and foreground scheduling, independently of catalog navigation. */
export function useSourceSubscriptionRefresh(port: SubscriptionRefreshPort) {
  const portRef = useRef(port);
  portRef.current = port;
  const mountedRef = useRef(true);
  const subscriptionAbortRef = useRef<AbortController>();
  const subscriptionCheckOffsetsRef = useRef(new Map<string, number>());
  const foregroundSubscriptionChecksRef = useRef(new Set<string>());
  const [checkingSubscriptions, setCheckingSubscriptions] = useState(false);
  const cancel = useCallback(() => {
    subscriptionAbortRef.current?.abort();
    subscriptionAbortRef.current = undefined;
    if (mountedRef.current) setCheckingSubscriptions(false);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  const reconcileSubscriptionPage = useCallback(
    async (
      sourceId: string,
      accountConnectionId: string | undefined,
      parentRef: string | undefined,
      page: {
        readonly detail?: ExternalSourceWorkDetail;
        readonly items: readonly ExternalItemSummary[];
        readonly cache?: ExternalItemPage['cache'];
      },
      complete: boolean,
      isCurrent: () => boolean = () => true,
    ) => {
      if (!parentRef || !page.detail || page.cache?.stale) return;
      const id = externalSourceSubscriptionId(sourceId, accountConnectionId, parentRef);
      let current = (await portRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current || !mountedRef.current || !isCurrent()) return;
      const releaseIds = page.items.filter((item) => item.release).map((item) => item.key.remoteId);
      const thumbnailUrl = current.thumbnailUrl?.startsWith('data:')
        ? current.thumbnailUrl
        : await persistentThumbnailUrl(page.detail.thumbnailUrl);
      if (!mountedRef.current || !isCurrent()) return;
      current = (await portRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current || current.deletedAt || !mountedRef.current || !isCurrent()) return;
      const next: ExternalSourceSubscriptionRecord = {
        ...current,
        title: current.titleOverride ?? page.detail.title,
        author: page.detail.author,
        description: page.detail.description,
        thumbnailUrl: thumbnailUrl ?? current.thumbnailUrl,
        sourceLabel: page.detail.sourceLabel,
        ...reconcileSubscriptionReleaseIds(current, releaseIds, complete),
        lastCheckedAt: complete ? currentIso() : current.lastCheckedAt,
        updatedAt: currentIso(),
      };
      await portRef.current.state.saveSubscription(next);
      if (mountedRef.current && isCurrent()) portRef.current.onRecord(next);
    },
    [],
  );

  const checkSubscriptions = useCallback(async () => {
    const { source, busy, subscriptions } = portRef.current;
    if (!source || busy || subscriptionAbortRef.current) return;
    const activeSourceId = source.id;
    if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
    const targets = subscriptions.filter(
      (item) =>
        !item.deletedAt &&
        item.connectorId === activeSourceId &&
        (item.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? ''),
    );
    if (targets.length === 0) return;
    const checkScope = JSON.stringify([activeSourceId, source.connection.accountConnectionId ?? '']);
    const startOffset = (subscriptionCheckOffsetsRef.current.get(checkScope) ?? 0) % targets.length;
    const orderedTargets = [...targets.slice(startOffset), ...targets.slice(0, startOffset)];
    const abort = new AbortController();
    subscriptionAbortRef.current = abort;
    setCheckingSubscriptions(true);
    let failed = 0;
    let checked = 0;
    let incomplete = 0;
    let remainingPages = MAX_SUBSCRIPTION_CHECK_TOTAL_PAGES;
    const isCurrent = () => {
      const current = portRef.current.registry.getExternalSourceStatus(activeSourceId, portRef.current.hostContext);
      return (
        !abort.signal.aborted &&
        subscriptionAbortRef.current === abort &&
        current.state === 'connected' &&
        current.connectionGeneration === source.connection.connectionGeneration &&
        (current.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? '')
      );
    };
    try {
      for (const subscription of orderedTargets.slice(0, 50)) {
        if (!isCurrent() || remainingPages === 0) break;
        try {
          const page = await collectSubscriptionReleasePages({
            signal: abort.signal,
            takePageBudget: () => {
              if (remainingPages === 0) return false;
              remainingPages -= 1;
              return true;
            },
            readPage: (cursor, signal) => {
              if (!isCurrent()) throw new DOMException('Operation cancelled', 'AbortError');
              return portRef.current.registry.listExternalSource(
                activeSourceId,
                portRef.current.hostContext,
                {
                  accountConnectionId: source.connection.accountConnectionId,
                  parentRef: subscription.navigationRef,
                  cursor,
                  cacheMode: cursor ? undefined : 'reload',
                },
                signal,
              );
            },
          });
          if (!isCurrent()) break;
          await reconcileSubscriptionPage(
            activeSourceId,
            source.connection.accountConnectionId,
            subscription.collectionRemoteId,
            page,
            page.complete,
            isCurrent,
          );
          checked += 1;
          if (!page.complete) incomplete += 1;
        } catch (error) {
          if (isAbort(error)) break;
          failed += 1;
        }
      }
      if (isCurrent())
        subscriptionCheckOffsetsRef.current.set(checkScope, (startOffset + checked + failed) % targets.length);
      const next = await portRef.current.state.listSubscriptions();
      if (!mountedRef.current || !isCurrent()) return;
      portRef.current.onSnapshot(next);
      if (incomplete > 0 || targets.length > checked + failed) {
        portRef.current.notify(
          `일부 회차 목록만 확인했습니다. ${incomplete}개 작품의 새 회차 판단이 미완료이며 기존 표시는 유지됩니다.${
            targets.length > checked + failed
              ? ` 아직 확인하지 않은 작품 ${targets.length - checked - failed}개가 있습니다.`
              : ''
          }${failed ? ` ${failed}개 작품은 목록을 불러오지 못했습니다.` : ''}`,
          'warning',
        );
      } else if (failed > 0) {
        portRef.current.notify(`라이브러리 작품 ${checked}개를 확인했고 ${failed}개는 확인하지 못했습니다.`, 'warning');
      }
    } finally {
      if (subscriptionAbortRef.current === abort) {
        subscriptionAbortRef.current = undefined;
        if (mountedRef.current) setCheckingSubscriptions(false);
      }
    }
  }, [reconcileSubscriptionPage]);

  const { source, subscriptions, foreground } = port;
  useEffect(() => {
    if (
      !foreground ||
      checkingSubscriptions ||
      !source?.supportsSubscriptions ||
      source.connection.state !== 'connected'
    )
      return;
    if (
      !subscriptions.some(
        (item) =>
          item.connectorId === source.id &&
          (item.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? ''),
      )
    )
      return;
    const key = `${source.id}::${source.connection.accountConnectionId ?? ''}`;
    if (foregroundSubscriptionChecksRef.current.has(key)) return;
    foregroundSubscriptionChecksRef.current.add(key);
    void checkSubscriptions();
  }, [foreground, checkingSubscriptions, source, subscriptions, checkSubscriptions]);

  return { checkingSubscriptions, checkSubscriptions, reconcileSubscriptionPage, cancel };
}
