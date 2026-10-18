import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { TTSDownloadJob, TTSDownloadPolicy } from '../../domain/types';
import type {
  IndexedDbHostedTTSOfflineCache,
  HostedTTSOfflineCacheStatus,
} from '../../storage/hosted-tts-offline-cache';
import type { IndexedDbTTSDownloadRepository } from '../../storage/tts-download-store';
import type { TTSCacheGateway } from './tts-cache-gateway';
import { formatBytes } from '../../utils/format';

type Policy = Pick<TTSDownloadPolicy, 'network' | 'charging'>;
export interface OfflineTTSDownloadsInput {
  readonly bookId?: string;
  readonly contentRevision?: string;
  readonly runtime: object;
  readonly accountKey?: string;
  readonly mobile: boolean;
  readonly cache: Pick<
    IndexedDbHostedTTSOfflineCache,
    'evidence' | 'status' | 'requestPersistence' | 'removeStaleForBook'
  >;
  readonly gateway?: TTSCacheGateway;
  readonly notify: (message: string, tone: 'success' | 'warning' | 'info') => void;
}
interface Snapshot {
  job?: TTSDownloadJob;
  error?: string;
  cacheStatus?: HostedTTSOfflineCacheStatus;
}

/** App-session download monitoring. Closing a panel does not revoke downloads or their persisted jobs. */
export function useOfflineTTSDownloads(input: OfflineTTSDownloadsInput) {
  const auxiliaryDatabase = useOptionalAppRuntime()?.readerRuntime.auxiliaryDatabase;
  const { bookId, contentRevision, runtime, accountKey, mobile, cache, gateway, notify } = input;
  const owner = useMemo(
    () => ({
      active: false,
      runtime,
      accountKey,
      cache,
      gateway,
      recovery: undefined as Promise<number> | undefined,
      repository: undefined as Promise<IndexedDbTTSDownloadRepository> | undefined,
    }),
    [runtime, accountKey, cache, gateway],
  );
  const scope = useMemo(
    () => ({ owner, bookId, contentRevision, active: false, epoch: 0, request: 0 }),
    [owner, bookId, contentRevision],
  );
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; value: Snapshot }>();
  const [policy, setPolicy] = useState<Policy>(() => ({ network: mobile ? 'unmetered' : 'any', charging: 'any' }));
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  useLayoutEffect(() => {
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
      scope.request++;
    };
  }, [scope]);
  const refresh = useCallback(async () => {
    if (!scope.active) return;
    const request = ++scope.request;
    const current = () => scope.active && request === scope.request;
    if (!bookId) {
      setSnapshot({ scope, value: {} });
      return;
    }
    try {
      const repository = await (owner.repository ??= import('../../storage/tts-download-store').then((downloads) =>
        auxiliaryDatabase
          ? new (downloads.createTTSDownloadStore(auxiliaryDatabase).IndexedDbTTSDownloadRepository)()
          : new downloads.IndexedDbTTSDownloadRepository(),
      ));
      if (!current()) return;
      const recovery =
        owner.recovery ??
        (async () => {
          const hashes = await repository.interruptedRenderSpecHashes();
          const [native, browser] = await Promise.all([
            hashes.length && gateway?.evidence ? gateway.evidence(hashes).catch(() => []) : [],
            hashes.length ? cache.evidence(bookId, hashes).catch(() => []) : [],
          ]);
          if (!owner.active) return 0;
          return repository.recoverInterrupted([...native, ...browser]);
        })();
      owner.recovery = recovery;
      try {
        await recovery;
      } catch (error) {
        if (owner.recovery === recovery) owner.recovery = undefined;
        throw error;
      }
      if (!current()) return;
      const job = contentRevision ? await repository.latestForBookRevision(bookId, contentRevision) : undefined;
      if (!current()) return;
      const [items, cacheStatus] = await Promise.all([
        job ? repository.listItems(job.id).catch(() => []) : [],
        cache.status(bookId, contentRevision).catch(() => undefined),
      ]);
      if (!current()) return;
      const error = items
        .filter((item) => item.state === 'failed' || item.state === 'retry_wait')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.errorMessage;
      setSnapshot({ scope, value: { job, error, cacheStatus } });
      if (mobile && job) setPolicy({ network: job.policy.network, charging: job.policy.charging });
    } catch (error) {
      if (current()) setSnapshot({ scope, value: {} });
      throw error;
    }
  }, [scope, owner, bookId, contentRevision, cache, gateway, mobile, auxiliaryDatabase]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  const requestStorage = async () => {
    if (!scope.active) return;
    const epoch = scope.epoch;
    const persisted = await cache.requestPersistence().catch(() => false);
    if (!scope.active || scope.epoch !== epoch) return;
    notify(
      persisted
        ? '오프라인 음성 저장소가 브라우저 자동 정리에서 보호됩니다.'
        : persisted === undefined
          ? '이 브라우저는 영구 저장소 요청을 지원하지 않습니다.'
          : '브라우저가 저장소 보호 요청을 허용하지 않았습니다.',
      persisted ? 'success' : 'warning',
    );
    await refresh().catch(() => undefined);
  };
  const removeStaleAudio = async () => {
    if (!scope.active || !bookId || !contentRevision) return;
    const epoch = scope.epoch;
    const result = await cache.removeStaleForBook(bookId, contentRevision);
    if (!scope.active || scope.epoch !== epoch) return;
    notify(
      result.removedItems > 0
        ? `이전 본문 음성 ${result.removedItems}개 · ${formatBytes(result.removedBytes)}를 정리했습니다.`
        : result.protectedItems > 0
          ? '수동 보관 중인 이전 음성만 남아 있어 자동으로 정리하지 않았습니다.'
          : '정리할 이전 본문 음성이 없습니다.',
      result.removedItems > 0 ? 'success' : 'info',
    );
    await refresh().catch(() => undefined);
  };
  return {
    ...(snapshot?.scope === scope ? snapshot.value : {}),
    policy,
    setPolicy,
    refresh,
    requestStorage,
    removeStaleAudio,
  };
}
