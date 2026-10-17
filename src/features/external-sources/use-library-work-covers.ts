import { useCoverCacheRevision } from '../../external-sources/cover-cache-changes';
import { useEffect, useMemo, useState } from 'react';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';

export type LibraryCoverWork = Pick<
  ExternalSourceSubscriptionRecord,
  'id' | 'connectorId' | 'accountConnectionId' | 'navigationRef' | 'collectionRemoteId'
>;

/** Device URLs are deliberately absent from synced subscriptions; resolve them on this device. */
export function useLibraryWorkCovers<T extends ExternalSourceSubscriptionRecord>(
  works: readonly T[],
  connectionKey: string,
  resolve: (work: LibraryCoverWork, signal: AbortSignal) => Promise<string | undefined>,
  peek?: (work: LibraryCoverWork) => string | undefined,
): readonly T[] {
  const revision = useCoverCacheRevision();
  const [covers, setCovers] = useState<ReadonlyMap<string, string>>(() => new Map());
  const targets = JSON.stringify(
    works
      .filter((work) => !work.thumbnailUrl)
      .map(({ id, connectorId, accountConnectionId, navigationRef, collectionRemoteId }) => ({
        id,
        connectorId,
        accountConnectionId,
        navigationRef,
        collectionRemoteId,
      })),
  );
  useEffect(() => {
    const pending = JSON.parse(targets) as LibraryCoverWork[];
    const abort = new AbortController();
    let next = 0;
    const run = async () => {
      while (next < pending.length && !abort.signal.aborted) {
        const work = pending[next++]!;
        const request = new AbortController();
        const cancel = () => request.abort();
        abort.signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(cancel, 10_000);
        let retained = false;
        try {
          const url = await resolve(work, request.signal);
          if (url && !request.signal.aborted) {
            retained = true;
            setCovers((current) => new Map(current).set(`${connectionKey}:${work.id}`, url));
          }
        } catch {
          // Optional artwork must never block the library or emit a notification.
        } finally {
          clearTimeout(timeout);
          // Successful artwork stays pinned until this effect leaves.
          if (!retained) {
            abort.signal.removeEventListener('abort', cancel);
            request.abort();
          }
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, pending.length) }, run));
    return () => abort.abort();
  }, [targets, connectionKey, resolve]);
  return useMemo(
    () =>
      works.map((work) => {
        const thumbnailUrl = work.thumbnailUrl ?? peek?.(work) ?? covers.get(`${connectionKey}:${work.id}`);
        return thumbnailUrl === work.thumbnailUrl ? work : { ...work, thumbnailUrl };
      }),
    // Background cache replacement changes peek results without changing its function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [works, covers, connectionKey, peek, revision],
  );
}
