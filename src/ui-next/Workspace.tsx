import '../features/discovery/discovery.css';
import { useShownSourceMetadata } from './library/use-shown-source-metadata';
import { useWorkspaceSearch } from './search/workspace-search';
import { UiNextHomeScreen } from './home/UiNextHomeScreen';
import { HomeDataContext } from './home/context';
import { createUiNextHomeAdapter } from './home/model';
import { createElement, Fragment, useContext, type ReactNode } from 'react';

import type { LibraryScreenProps } from '../features/library/library-screen-contract';

import { UiNextShell } from './shell/UiNextShell';
import { UiNextNavigationContext } from './shell/context';
import { useUiNextNavigation } from './shell/navigation';
import { UiNextLibraryScreen } from './library/UiNextLibraryScreen';
import { createUiNextLibraryAdapter } from './library/model';

function NextWorkspace(input: LibraryScreenProps & { view: string; children: ReactNode }) {
  const navigation = useUiNextNavigation(input, input.view);
  const search = useWorkspaceSearch(input);
  const props = { ...input, children: createElement(Fragment, null, input.children, search) };
  return (
    <UiNextNavigationContext.Provider value={navigation}>
      <UiNextShell {...navigation}>{props.children}</UiNextShell>
    </UiNextNavigationContext.Provider>
  );
}
export function UiNextWorkspace(props: LibraryScreenProps & { view: string; children: ReactNode }) {
  return <NextWorkspace {...props} />;
}
export function WorkspaceLibraryScreen(props: LibraryScreenProps) {
  const navigation = useContext(UiNextNavigationContext);
  const home = useContext(HomeDataContext);
  const homeAdapter =
    navigation?.activeTab === 'home' && home ? createUiNextHomeAdapter(props, { ...home, navigation }) : undefined;
  const libraryAdapter = navigation ? createUiNextLibraryAdapter(props) : undefined;
  useShownSourceMetadata(
    homeAdapter
      ? [
          ...homeAdapter.hero.map((hero) => hero.item),
          ...homeAdapter.rows.flatMap((row) =>
            row.items.flatMap((item) => (item.kind === 'library' ? [item.item] : [])),
          ),
        ]
      : (libraryAdapter?.works ?? []),
  );
  if (navigation && homeAdapter)
    return <UiNextHomeScreen adapter={homeAdapter} navigation={navigation} libraryProps={props} />;
  return <UiNextLibraryScreen {...props} navigation={navigation!} adapter={libraryAdapter!} />;
}
