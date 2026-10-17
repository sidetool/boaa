import { setHomeActive, useHomeActive } from '../home/route';
import { openSearch } from '../search/route';
import { useState } from 'react';
import type { LibraryScreenProps } from '../../features/library/library-screen-contract';
import type { UiNextNavigation } from './contract';

export function createUiNextNavigation(
  { model, actions }: LibraryScreenProps,
  view: string,
  searchFocusRequest: number,
  requestSearchFocus: () => void,
  homeActive = false,
): UiNextNavigation {
  const openLibraryRoot = () => {
    setHomeActive(false);
    actions.presentation.goHome();
    actions.controls.setShelf(undefined);
  };
  return {
    activeTab:
      view === 'library' && (model.discovery?.active || model.externalSources.active)
        ? 'discovery'
        : homeActive
          ? 'home'
          : 'library',
    isReader: view === 'reader' || view === 'document',
    readerOverlay: view === 'library' && model.externalSources.active && Boolean(model.externalSources.streaming),
    openHome: () => {
      openLibraryRoot();
      setHomeActive(true);
    },
    openDiscovery: actions.header.openDiscovery
      ? () => {
          setHomeActive(false);
          actions.header.openDiscovery!();
        }
      : undefined,
    openLibraryRoot,
    openSettings: actions.header.openSettings,
    openSearch,
    searchFocusRequest,
    focusSearch: () => {
      openLibraryRoot();
      requestSearchFocus();
    },
  };
}
export function useUiNextNavigation(props: LibraryScreenProps, view: string): UiNextNavigation {
  const [request, setRequest] = useState(0);
  const homeActive = useHomeActive();
  return createUiNextNavigation(props, view, request, () => setRequest((value) => value + 1), homeActive);
}
