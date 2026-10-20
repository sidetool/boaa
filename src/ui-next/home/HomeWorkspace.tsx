import { withSourceMetadata } from '../../features/library/library-source-metadata';
import { homeSourceContinuity } from './source-continuity';
import { useHomeDiscovery } from './useHomeDiscovery';

import { useMemo } from 'react';
import {
  BookWorkspaceScreens,
  type BookWorkspaceScreensProps,
} from '../../features/book-workspace/BookWorkspaceScreens';
import type { ReaderSettingsController } from '../../features/reader-settings/useReaderSettingsDraft';
import { libraryShelfMemberships } from '../../features/book-workspace/library-shelf-memberships';
import { withSourceProgress } from '../../features/library/library-source-progress';
import { HomeDataContext } from './context';
import type { HomeRowConfig } from './contract';

/** Supplies the full catalog upstream of the workspace's filter/shelf projection. */
function NextHomeWorkspace({
  homeSettings,
  ...props
}: BookWorkspaceScreensProps & {
  homeSettings: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
}) {
  const { projection, externalSources, libraryManagement } = props;
  const { settings, updateSettings } = homeSettings;
  const discoveryRows = useHomeDiscovery(props);
  const sourceContinuity = useMemo(
    () =>
      homeSourceContinuity({
        libraryWorks: externalSources.libraryWorks,
        sourceVisits: externalSources.sourceVisits,
        sourceHistoryScope: externalSources.sourceHistoryScope,
      }),
    [externalSources.libraryWorks, externalSources.sourceVisits, externalSources.sourceHistoryScope],
  );
  const data = useMemo(
    () => ({
      search: { discovery: props.discovery, externalSources, controller: props.controller, preferences: homeSettings },
      discoveryRows,
      sourcePositions: sourceContinuity.positions,
      books: [...projection.libraryCollection.booksByNovelId.values()].map((book) =>
        withSourceProgress(
          withSourceMetadata(book, externalSources.libraryWorks),
          externalSources.sourceWorkProgress?.byNovelId.get(book.novel.id),
        ),
      ),
      externalWorks: externalSources.libraryWorks
        .filter((work) => !work.localBookId)
        .map((work) => ({
          id: work.id,
          title: work.title,
          titleUnknown: work.titleUnknown,
          requestMetadata: work.requestMetadata,
          author: work.author,
          description: work.description,
          thumbnailUrl: work.thumbnailUrl,
          sourceLabel: work.sourceLabel,
          availableReleaseCount: work.availableReleaseCount,
          readReleaseCount: externalSources.sourceWorkProgress?.bySubscriptionId.get(work.id)?.readCount,
          lastReadAt:
            externalSources.sourceWorkProgress?.bySubscriptionId.get(work.id)?.lastReadAt ??
            sourceContinuity.positions.get(`external:${work.id}`)?.lastReadAt,
          newReleaseCount: work.newReleaseIds.length,
          addedAt: work.createdAt,
          updatedAt: work.updatedAt,
          deletedAt: work.deletedAt,
        })),
      currentChapters: new Map([
        ...sourceContinuity.chapters,
        ...(props.state?.selectedNovel
          ? props.state.chapters
              .filter((chapter) =>
                props.state.selectedNovel!.lastReadChapterId
                  ? chapter.id === props.state.selectedNovel!.lastReadChapterId
                  : chapter.index === props.state.selectedNovel!.lastReadChapterIndex,
              )
              .map(
                (chapter) =>
                  [`book:${props.state.selectedNovel!.id}`, { index: chapter.index, title: chapter.title }] as const,
              )
          : []),
      ]),
      updatedBookIds: new Set(
        externalSources.libraryWorks
          .filter((work) => !work.deletedAt && work.localBookId && work.newReleaseIds.length > 0)
          .map((work) => work.localBookId!),
      ),
      memberships: libraryShelfMemberships(libraryManagement.memberships, externalSources.libraryWorks),
      config: settings.homeRows,
      showSourceRanks: settings.showHomeSourceRanks === true,
      setConfig: (homeRows: readonly HomeRowConfig[]) =>
        updateSettings((previous) => ({ ...previous, homeRows: [...homeRows] })),
    }),
    [
      discoveryRows,
      props.discovery,
      props.controller,
      externalSources,
      homeSettings,
      sourceContinuity,
      projection.libraryCollection.booksByNovelId,
      props.state?.selectedNovel,
      props.state?.chapters,
      libraryManagement.memberships,
      settings.homeRows,
      settings.showHomeSourceRanks,
      updateSettings,
    ],
  );
  return (
    <HomeDataContext.Provider value={data}>
      <BookWorkspaceScreens {...props} />
    </HomeDataContext.Provider>
  );
}

export function HomeWorkspace(props: Parameters<typeof NextHomeWorkspace>[0]) {
  return <NextHomeWorkspace {...props} />;
}
