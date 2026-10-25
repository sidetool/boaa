import type { UseExternalSourceControllerOptions } from './external-source-controller-contract';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { Novel } from '../../domain/types';
import type { ExternalSourceLocalState } from '../../external-sources/local-state';
import { reconcileSourceLibrary } from './source-library-reconciliation';

export interface SourceLibrarySnapshotPort {
  readonly registry?: Pick<UseExternalSourceControllerOptions['registry'], 'getExternalSourceStatus'> &
    Partial<Pick<UseExternalSourceControllerOptions['registry'], 'getExternalSources'>>;
  readonly hostContext?: UseExternalSourceControllerOptions['hostContext'];
  readonly state: ExternalSourceLocalState;
  readonly settingsScope?: string;
  readonly assets?: BookAssetRepository;
  waitForReadingHistory?(): Promise<void>;
  listNovels(options?: { includeTrash?: boolean }): Promise<Novel[]>;
}

/** Ordered read only: failed catalogs never become empty successful snapshots. */
export async function readSourceLibrary(options: SourceLibrarySnapshotPort) {
  await options.waitForReadingHistory?.();
  // A catalog snapshot taken before a new link must never prune that link.
  const links = await options.state.listLinks();
  const novels = await options.listNovels({ includeTrash: true });
  return { links, novels };
}

export type SourceLibraryReadSnapshot = Awaited<ReturnType<typeof readSourceLibrary>>;
export type SourceLibrarySnapshot = Awaited<ReturnType<typeof reconcileSourceLibrary>>;

/** Each pass captures its account port and reads afresh. Reconciliation is repeatable
 * and uses the storage operation/revision fences; slow reads must not block a retry.
 */
export async function loadSourceLibrary(options: SourceLibrarySnapshotPort): Promise<SourceLibrarySnapshot> {
  return reconcileSourceLibrary(options, await readSourceLibrary(options));
}
