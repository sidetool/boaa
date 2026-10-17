import { useEffect } from 'react';
import type { LibraryWorkItem } from '../../features/library/library-work-order';

/** Only adapter items actually rendered by the active screen request missing metadata. Resolver deduplicates calls. */
export function useShownSourceMetadata(items: readonly LibraryWorkItem[]) {
  useEffect(() => {
    for (const item of items) {
      const work = item.kind === 'book' ? item.book : item.work;
      if (work.titleUnknown) void work.requestMetadata?.();
    }
  }, [items]);
}
