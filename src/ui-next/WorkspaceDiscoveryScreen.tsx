import { lazy } from 'react';
import type { DiscoveryScreenProps } from '../features/discovery/useDiscoveryScreenState';

const NextDiscoveryScreen = lazy(() => import('./discovery/UiNextDiscoveryScreen'));

export function WorkspaceDiscoveryScreen(props: DiscoveryScreenProps) {
  return <NextDiscoveryScreen {...props} />;
}
