import { lazy } from 'react';
import type { SourceHubScreenProps } from '../features/external-sources/source-hub-contract';

const NextSourceHubScreen = lazy(() => import('./source/UiNextSourceHubScreen'));
export function WorkspaceSourceHubScreen(props: SourceHubScreenProps) {
  return <NextSourceHubScreen {...props} />;
}
