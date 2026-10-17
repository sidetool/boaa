import { randomUuid } from '../../utils/random-uuid';
import { rememberNavigationViewState } from '../navigation/navigation-view-state';
import { saveDiscoverySelection } from './use-discovery-selection';
import type { DiscoverySection } from './discovery-config';

export const discoverySourceDestinationKey = (scope: string) => `discovery-source-destination:${scope}`;

/** Explicit source-list entry gets fresh controls; list/cover caches still use the shared request identity. */
export interface DiscoverySourceDestination extends DiscoverySection {
  query?: string;
}
export function rememberDiscoverySourceDestination(scope: string, section: DiscoverySection, query?: string) {
  const destination: DiscoverySourceDestination = { ...section, query, id: `source-destination:${randomUuid()}` };
  rememberNavigationViewState(discoverySourceDestinationKey(scope), destination);
  rememberNavigationViewState(`discovery-quick:${scope}`, section.sourceId);
  saveDiscoverySelection(scope, { quickSource: section.sourceId });
  return destination;
}
