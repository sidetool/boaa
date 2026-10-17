import { useSyncExternalStore } from 'react';
import { coverChangeRevision, subscribeCoverChanges } from './cover-change-events';

export { coverChangeRevision, publishCoverChange, subscribeCoverChanges } from './cover-change-events';
export function useCoverCacheRevision() {
  return useSyncExternalStore(subscribeCoverChanges, coverChangeRevision, coverChangeRevision);
}
