import type { ExternalItemSummary } from '../../external-sources/contracts';
import { externalItemKeyId } from '../../external-sources/contracts';
import { parseSerialReleaseName } from '../../domain/serial-release-name';
import type { ExternalSourceController, ExternalSourceItemView } from './external-source-controller-contract';
import { filterAndSortReleases, type ReleaseSort } from './source-release-list-model';

/** Display data only. Correct common zero-based numbering when a title explicitly identifies the episode. */
export function sourceEpisodeNumber(item: Pick<ExternalItemSummary, 'title' | 'release'>, position = 0): number {
  const parsed = parseSerialReleaseName(item.release?.title ?? item.title).chapterNumber;
  const raw = item.release?.chapterNumber;
  if (parsed !== undefined && Number.isFinite(parsed) && (raw === undefined || raw === 0 || parsed === raw + 1))
    return parsed;
  if (raw !== undefined && Number.isFinite(raw) && raw > 0) return raw;
  const order = item.release?.sourceOrder;
  return order !== undefined && Number.isFinite(order) && order > 0 ? order : Math.max(0, position) + 1;
}
export interface PrimarySourceRead {
  readonly kind: 'first' | 'continue';
  readonly episodeTitle: string;
  readonly episodeNumber: number;
  readonly item: ExternalSourceItemView;
  readonly busy: boolean;
  run(): Promise<void>;
}
/** The caller may pass the list's sort; read history always takes precedence over first-episode selection. */
export function sourcePrimaryRead(
  controller: ExternalSourceController,
  sort: ReleaseSort = 'asc',
): PrimarySourceRead | undefined {
  const items = filterAndSortReleases(
    controller.items.filter((item) => item.release && item.importState !== 'unsupported'),
    '',
    'all',
    sort,
  );
  const history = controller.currentWorkVisit;
  const visit =
    history?.read === false && (history.readChangedAt ?? history.updatedAt) >= (history.lastReadAt ?? '')
      ? undefined
      : history;
  const known =
    items.find((item) => visit && externalItemKeyId(item.key) === externalItemKeyId(visit.source)) ??
    items.find((item) => item.readingState === 'current');
  const previous =
    known ??
    (visit?.lastReadAt && visit.read !== false
      ? {
          key: visit.source,
          kind: 'file' as const,
          title: visit.lastReadRelease?.title ?? visit.title ?? visit.source.remoteId,
          release: {
            title: visit.lastReadRelease?.title ?? visit.title ?? visit.source.remoteId,
            chapterNumber: visit.lastReadRelease?.number,
          },
          collection: visit.collectionRemoteId
            ? { remoteId: visit.collectionRemoteId, title: controller.detail?.title ?? visit.collectionRemoteId }
            : undefined,
          importability: 'supported' as const,
          importState: 'available' as const,
          selected: false,
        }
      : undefined);
  const item = previous ?? items[0];
  if (!item) return;
  return {
    kind: previous ? 'continue' : 'first',
    episodeTitle: item.release?.title ?? item.title,
    episodeNumber: sourceEpisodeNumber(item, items.indexOf(item)),
    item,
    busy: Boolean(controller.openingItemKey || controller.loading || controller.blockingBusy),
    run: async () => {
      if (controller.openingItemKey || controller.loading || controller.blockingBusy) return;
      if (previous && controller.canResumeCurrentWork && controller.resumeCurrentWork)
        await controller.resumeCurrentWork();
      else if (item.localBookId && ['imported', 'update_available'].includes(item.importState))
        await controller.openImported(item);
      else await controller.importAndOpen(item);
    },
  };
}
