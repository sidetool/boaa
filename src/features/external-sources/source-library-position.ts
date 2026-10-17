import type { Chapter, Novel } from '../../domain/types';
import type { ExternalItemSummary, ExternalSourceLink } from '../../external-sources/contracts';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';
import { sourceEpisodeNumber } from './source-primary-read';
import { filterAndSortReleases } from './source-release-list-model';
import type { ExternalSourceItemView } from './external-source-controller-contract';
import { parseSerialReleaseName } from '../../domain/serial-release-name';

export interface SourceLibraryPosition {
  readonly episodeNumber: number;
  readonly episodeTitle?: string;
  /** One-based position in the source catalogue, distinct from the saved chapter index. */
  readonly position: number;
  readonly total: number;
  readonly progress: number;
}
export function sourceLibraryPosition(
  novel: Novel,
  chapters: readonly Chapter[],
  links: readonly ExternalSourceLink[],
  catalog: readonly ExternalItemSummary[],
  total: number,
): SourceLibraryPosition | undefined {
  if (novel.format !== 'txt' || !total) return;
  const chapter = chapters.find((chapter) =>
    novel.lastReadChapterId ? chapter.id === novel.lastReadChapterId : chapter.index === novel.lastReadChapterIndex,
  );
  if (!chapter?.documentSectionId) return;
  const link = links.find(
    (link) =>
      link.localBookId === novel.id &&
      !link.pendingImport &&
      link.collectionRemoteId &&
      (link.source.remoteId === chapter.documentSectionId ||
        externalDocumentReleaseSourceId(link.source, link.collectionRemoteId) === chapter.documentSectionId),
  );
  if (!link) return;
  const ordered = filterAndSortReleases(
    catalog.map((item) => ({ ...item, selected: false, importState: 'available' })) as ExternalSourceItemView[],
    '',
    'all',
    'asc',
  );
  const index = ordered.findIndex((item) => item.key.remoteId === link.source.remoteId);
  const episodeTitle = index >= 0 ? (ordered[index].release?.title ?? ordered[index].title) : chapter.title;
  const number =
    index >= 0 ? sourceEpisodeNumber(ordered[index], index) : parseSerialReleaseName(episodeTitle).chapterNumber;
  if (!number || number <= 0) return;
  const position = ordered.length === total && index >= 0 ? index + 1 : number;
  return { episodeNumber: number, episodeTitle, position, total, progress: Math.min(1, position / total) };
}
