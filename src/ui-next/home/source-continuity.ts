import { externalItemKeyId } from '../../external-sources/contracts';
import { readSourceStreamPosition } from '../../external-sources/source-stream-history';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import type { HomeCurrentChapter } from './hero-labels';

export interface HomeSourcePosition {
  readonly episodeTitle?: string;
  readonly episodeNumber?: number;
  readonly lastReadAt: string;
  readonly page?: number;
  readonly count?: number;
  readonly progress?: number;
}
/** Library records supply work identity/cover/actions; visit history supplies the actual resumed episode. No network. */
export function homeSourceContinuity(
  controller: Pick<ExternalSourceController, 'libraryWorks' | 'sourceVisits' | 'sourceHistoryScope'>,
) {
  const chapters = new Map<string, HomeCurrentChapter>();
  const positions = new Map<string, HomeSourcePosition>();
  for (const work of controller.libraryWorks) {
    if (work.deletedAt || work.localBookId) continue;
    const visit = controller.sourceVisits?.get(
      externalItemKeyId({
        connectorId: work.connectorId,
        accountConnectionId: work.accountConnectionId,
        remoteId: work.collectionRemoteId,
      }),
    );
    if (!visit?.lastReadAt || (visit.read === false && (visit.readChangedAt ?? visit.updatedAt) >= visit.lastReadAt))
      continue;
    const key = `external:${work.id}`;
    const position = readSourceStreamPosition(
      JSON.stringify([controller.sourceHistoryScope, externalItemKeyId(visit.source)]),
    );
    if (visit.lastReadRelease)
      chapters.set(key, { index: visit.lastReadRelease.number, title: visit.lastReadRelease.title });
    positions.set(key, {
      lastReadAt: visit.lastReadAt,
      episodeTitle: visit.lastReadRelease?.title,
      episodeNumber: visit.lastReadRelease?.number,
      page: position?.page,
      count: position?.count,
      progress: position ? Math.min(1, (position.page + 1) / position.count) : undefined,
    });
  }
  return { chapters, positions };
}
