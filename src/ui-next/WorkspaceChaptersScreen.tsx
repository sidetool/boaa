import { lazy } from 'react';
import type { ChaptersScreenProps } from '../features/chapters/chapters-screen-contract';

const NextChaptersScreen = lazy(() =>
  import('./chapters/UiNextChaptersScreen').then((module) => ({ default: module.UiNextChaptersScreen })),
);

/** The workspace owns the existing Suspense fallback and history-backed actions. */
export function WorkspaceChaptersScreen(props: ChaptersScreenProps) {
  return <NextChaptersScreen {...props} />;
}
