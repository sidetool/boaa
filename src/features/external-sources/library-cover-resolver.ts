import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
import type { LibraryCoverWork } from './use-library-work-covers';

type Options = Pick<UseExternalSourceControllerOptions, 'registry' | 'hostContext'>;
/** Work IDs address source covers directly: memory/IndexedDB lookup never waits for a catalogue POST.
 * peek(work) is synchronous; resolve(work, signal) acquires URL ownership. Sources without a direct
 * cover result retain the existing detail lookup fallback. No subscription or synced URL is written.
 */
export function createLibraryCoverResolver(current: () => Options) {
  const key = (work: LibraryCoverWork) => ({
    connectorId: work.connectorId,
    accountConnectionId: work.accountConnectionId,
    remoteId: work.collectionRemoteId,
  });
  const connected = (options: Options, work: LibraryCoverWork) => {
    const status = options.registry.getExternalSourceStatus(
      work.connectorId as ExtensionContributionId,
      options.hostContext,
    );
    return status.state === 'connected' && status.accountConnectionId === work.accountConnectionId;
  };
  return {
    peek(work: LibraryCoverWork) {
      const options = current();
      if (!connected(options, work)) return;
      return options.registry.peekExternalSourceCover?.(
        work.connectorId as ExtensionContributionId,
        options.hostContext,
        key(work),
      );
    },
    async resolve(work: LibraryCoverWork, signal: AbortSignal) {
      signal.throwIfAborted();
      const options = current();
      if (!connected(options, work)) return;
      const sourceId = work.connectorId as ExtensionContributionId;
      const url = await options.registry.resolveExternalSourceCover?.(sourceId, options.hostContext, key(work), signal);
      signal.throwIfAborted();
      if (url) return url;
      const page = await options.registry.listExternalSource(
        sourceId,
        options.hostContext,
        { parentRef: work.navigationRef },
        signal,
      );
      signal.throwIfAborted();
      if (page.detail?.thumbnailUrl) return page.detail.thumbnailUrl;
      const ref = page.detail?.coverRef;
      return ref
        ? options.registry.resolveExternalSourceCover?.(
            ref.connectorId as ExtensionContributionId,
            options.hostContext,
            ref,
            signal,
          )
        : undefined;
    },
  };
}
