import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import type { ExternalSourceWorkDetail, ExternalItemSummary } from '../../external-sources/contracts';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
import { cachePageId } from '../../external-sources/cached-page';
import { persistentThumbnailUrl } from './source-persistent-thumbnail';

/** Never turn opaque source identifiers into display text. User-authored overrides are handled by callers. */
export function knownWorkTitle(
  values: readonly (string | undefined)[],
  ids: readonly string[] = [],
): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value) => Boolean(value) && !ids.includes(value!) && !/^(?:sha256:)?[a-f\d]{16,}$/iu.test(value!));
}
export function sourceWorkMetadata(
  record: ExternalSourceSubscriptionRecord,
  detail?: ExternalSourceWorkDetail,
  items: readonly ExternalItemSummary[] = [],
) {
  const item = items.find((item) => item.collection?.remoteId === record.collectionRemoteId);
  const title =
    record.titleOverride?.trim() ||
    knownWorkTitle(
      [record.title, detail?.title, item?.collection?.title],
      [record.collectionRemoteId, record.navigationRef],
    );
  return {
    title: title ?? '',
    titleUnknown: !title,
    author: record.author ?? detail?.author ?? item?.author,
    description: record.description ?? detail?.description,
    thumbnailUrl: record.thumbnailUrl ?? detail?.thumbnailUrl ?? item?.thumbnailUrl,
  };
}

/** Lazy once-per-work/connection resolver. Requests on a source are serialized and all writes retain current user metadata. */
export function createSourceWorkMetadataLoader(
  options: UseExternalSourceControllerOptions,
  publish: (record: ExternalSourceSubscriptionRecord) => void,
) {
  const attempts = new Map<string, Promise<void>>();
  const queues = new Map<string, Promise<void>>();
  const abort = new AbortController();
  return {
    dispose: () => abort.abort(),
    request(work: ExternalSourceSubscriptionRecord): Promise<void> {
      if (abort.signal.aborted || work.deletedAt) return Promise.resolve();
      const sourceId = work.connectorId as ExtensionContributionId;
      let status;
      try {
        status = options.registry.getExternalSourceStatus(sourceId, options.hostContext);
      } catch {
        return Promise.resolve();
      }
      if (status.state !== 'connected' || status.accountConnectionId !== work.accountConnectionId)
        return Promise.resolve();
      const connection = JSON.stringify([status.accountConnectionId, status.connectionGeneration]);
      const key = `${connection}:${work.id}`;
      const existing = attempts.get(key);
      if (existing) return existing;
      const valid = () => {
        const now = options.registry.getExternalSourceStatus(sourceId, options.hostContext);
        return (
          !abort.signal.aborted &&
          now.state === 'connected' &&
          JSON.stringify([now.accountConnectionId, now.connectionGeneration]) === connection
        );
      };
      const task = (queues.get(sourceId) ?? Promise.resolve())
        .then(async () => {
          if (!valid()) return;
          const input = { parentRef: work.navigationRef, accountConnectionId: work.accountConnectionId };
          const cached = await options.state
            .getCachePage(
              cachePageId(
                sourceId,
                work.accountConnectionId,
                input,
                options.settingsScope,
                status.connectionGeneration,
              ),
            )
            .catch(() => undefined);
          let metadata = sourceWorkMetadata(work, cached?.detail, cached?.items);
          if (metadata.titleUnknown && valid()) {
            const request = new AbortController();
            const cancel = () => request.abort();
            abort.signal.addEventListener('abort', cancel, { once: true });
            const timeout = setTimeout(cancel, 10000);
            try {
              const page = await options.registry.listExternalSource(
                sourceId,
                options.hostContext,
                input,
                request.signal,
              );
              request.signal.throwIfAborted();
              metadata = sourceWorkMetadata(work, page.detail, page.items);
            } finally {
              clearTimeout(timeout);
              abort.signal.removeEventListener('abort', cancel);
            }
          }
          if (!valid()) return;
          const current = (await options.state.listSubscriptions()).find((record) => record.id === work.id);
          if (!current || current.deletedAt || !valid()) return;
          const merged = sourceWorkMetadata(current, metadata);
          const next = {
            ...current,
            ...merged,
            thumbnailUrl: await persistentThumbnailUrl(merged.thumbnailUrl),
            updatedAt: new Date().toISOString(),
          };
          if (!valid()) return;
          await options.state.saveSubscription(next);
          if (valid()) publish(next);
        })
        .catch(() => undefined);
      attempts.set(key, task);
      queues.set(sourceId, task);
      return task;
    },
  };
}
