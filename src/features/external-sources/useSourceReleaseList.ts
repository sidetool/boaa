/** useSourceReleaseList(controller, items) — mount in the release-list UI (same lifecycle as classic panel).
 * Returns query/setQuery, readFilter/setReadFilter, sort/setSort, sorted, requestedPage/setRequestedPage,
 * page (items/ranges/pageCount), cursor/partial, selectable/selectedHere/selectedTotal and selectionRef
 * (indeterminate checkbox). changeQuery/changeFilter/changeSort/reset reset the page exactly as classic;
 * selectPage selects only current-page keys; setSelectedRead marks all selected releases, swallowing errors
 * as the classic buttons do. loadMore/retryList forward catalog operations.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useNavigationViewState } from '../navigation/navigation-view-state';
import { externalItemKeyId } from '../../external-sources/contracts';
import { useReadingChapterPage } from '../chapters/use-reading-chapter-page';
import {
  filterAndSortReleases,
  paginateReleases,
  SOURCE_RELEASE_PAGE_SIZE,
  type ReleaseReadFilter,
  type ReleaseSort,
} from './source-release-list-model';
import type { ExternalSourceController, ExternalSourceItemView } from './external-source-controller-contract';

export function useSourceReleaseList(controller: ExternalSourceController, items: readonly ExternalSourceItemView[]) {
  const location = JSON.stringify([
    'source-releases',
    controller.activeSourceId,
    controller.localSeriesNovel?.id,
    controller.breadcrumbs.map((item) => item.parentRef),
  ]);
  const [query, setQuery] = useNavigationViewState(`${location}:query`, '');
  const [readFilter, setReadFilter] = useNavigationViewState<ReleaseReadFilter>(`${location}:filter`, 'all');
  const [sort, setSort] = useNavigationViewState<ReleaseSort>(`${location}:sort`, 'asc');
  const sorted = useMemo(() => filterAndSortReleases(items, query, readFilter, sort), [items, query, readFilter, sort]);
  const [requestedPage, setRequestedPage] = useReadingChapterPage(
    `${location}:page`,
    sorted.findIndex((item) => item.readingState === 'current'),
    sorted.length,
    SOURCE_RELEASE_PAGE_SIZE,
    // Keep downloaded subsets usable, but settle the reading page only after catalog preparation.
    !controller.loading &&
      !controller.readingHistoryLoading &&
      !controller.catalogPreparing &&
      !controller.nextCursor &&
      !controller.listError &&
      !controller.stale,
  );
  const page = paginateReleases(sorted, requestedPage);
  const cursor = controller.nextCursor;
  const partial = Boolean(cursor || controller.listError || controller.stale);

  const selectable = page.items.filter(
    (item) =>
      item.importability !== 'unsupported' &&
      (item.importState === 'available' || item.importState === 'update_available' || item.importState === 'imported'),
  );
  const selectedHere = selectable.filter((item) => item.selected).length;
  const selectedTotal = items.filter(
    (item) =>
      item.selected &&
      (item.importState === 'available' || item.importState === 'update_available' || item.importState === 'imported'),
  ).length;
  const selectionRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectionRef.current) selectionRef.current.indeterminate = selectedHere > 0 && selectedHere < selectable.length;
  }, [selectedHere, selectable.length]);

  const changeQuery = (value: string) => {
    setQuery(value);
    setRequestedPage(1);
  };
  const changeFilter = (value: ReleaseReadFilter) => {
    setReadFilter(value);
    setRequestedPage(1);
  };
  const changeSort = (value: ReleaseSort) => {
    setSort(value);
    setRequestedPage(1);
  };
  const reset = () => {
    setQuery('');
    setReadFilter('all');
    setRequestedPage(1);
  };
  const selectPage = (selected: boolean) =>
    controller.selectAllSupported(
      selected,
      selectable.map((item) => externalItemKeyId(item.key)),
    );
  const setSelectedRead = (read: boolean) =>
    void controller
      .setReleasesRead?.(
        items.filter((item) => item.selected),
        read,
      )
      .catch(() => undefined);
  return {
    query,
    setQuery,
    readFilter,
    setReadFilter,
    sort,
    setSort,
    sorted,
    requestedPage,
    setRequestedPage,
    page,
    cursor,
    partial,
    selectable,
    selectedHere,
    selectedTotal,
    selectionRef,
    changeQuery,
    changeFilter,
    changeSort,
    reset,
    selectPage,
    setSelectedRead,
    loadMore: () => void controller.loadMore(),
    retryList: () => void controller.listError?.retry(),
  };
}
