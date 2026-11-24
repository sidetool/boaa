import { createElement, useContext } from 'react';
import type { LibraryScreenProps } from '../../features/library/library-screen-contract';
import { HomeDataContext } from '../home/context';
import { useSearchAdapter } from './use-search-adapter';
import { UiNextSearchScreen } from './UiNextSearchScreen';
import { closeSearch, useSearchRoute, type SearchRoute } from './route';

function SearchWorkspace(props: LibraryScreenProps & { route: SearchRoute }) {
  const home = useContext(HomeDataContext);
  const adapter = useSearchAdapter(props, home, home?.search, props.route);
  return createElement(UiNextSearchScreen, {
    adapter,
    initialQuery: props.route.initialQuery,
    routeId: props.route.id,
    close: closeSearch,
  });
}

/** Route selection only; presentation is supplied by UiNextSearchScreen. */
export function useWorkspaceSearch(props: LibraryScreenProps) {
  const route = useSearchRoute();
  return route ? createElement(SearchWorkspace, { ...props, key: route.id, route }) : undefined;
}
