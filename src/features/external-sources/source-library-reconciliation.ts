import { finishSourceAssociationPurges } from './source-work-history';
import { recoverLinkedWorkMetadata } from './recover-linked-work-metadata';

import { recoverStreamLibrary } from './recover-stream-library';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { Novel } from '../../domain/types';
import type { ExternalSourceLink } from '../../external-sources/contracts';
import { reconcilePendingExternalSourceLinks } from '../../external-sources/link-import-reconciliation';
import {
  pendingSourceStreamPreferences,
  recoverSourceStreamVisits,
} from '../../external-sources/source-stream-visit-journal';

import type { SourceLibrarySnapshotPort, SourceLibraryReadSnapshot } from './source-library-snapshot';

function normalizedSourceHash(value: string | undefined): string | undefined {
  return value
    ?.replace(/^sha256:/iu, '')
    .trim()
    .toLocaleLowerCase();
}

async function importerResolvedSeriesIsActive(
  assets: BookAssetRepository | undefined,
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): Promise<boolean | undefined> {
  if (!assets) return undefined;
  if (!novel.activeContentRevisionId || !novel.sourceContentHash) return false;
  const source = await assets.exportSource(novel.id);
  if (!source || normalizedSourceHash(source.metadata.contentHash) !== normalizedSourceHash(novel.sourceContentHash)) {
    return false;
  }
  const { readSeriesImageArchiveManifest } = await import('../../services/import/series-image-archive');
  const manifest = await readSeriesImageArchiveManifest(source.blob);
  if (!manifest) return false;
  const sections = new Map(manifest.chapters.map((chapter) => [chapter.remoteId, chapter]));
  return staged.every((link) => {
    const pending = link.pendingImport;
    const section = sections.get(link.source.remoteId);
    return Boolean(
      pending?.sourceHashResolvedByImporter &&
      section &&
      (!pending.collectionRemoteId || pending.collectionRemoteId === manifest.collection.remoteId) &&
      normalizedSourceHash(pending.importedSourceContentHash) === normalizedSourceHash(section.sourceContentHash),
    );
  });
}

/** Repeatable writes run only after a successful ordered catalog read. */
export async function reconcileSourceLibrary(options: SourceLibrarySnapshotPort, snapshot: SourceLibraryReadSnapshot) {
  const { links, novels } = snapshot;
  const reconciled = await reconcilePendingExternalSourceLinks(options.state, links, novels, Date.now(), {
    catalogIncludesTrash: true,
    history: { scope: options.settingsScope, preferences: pendingSourceStreamPreferences(options.settingsScope) },
    resolveImporterApplied: (staged, novel) => importerResolvedSeriesIsActive(options.assets, staged, novel),
  });
  await finishSourceAssociationPurges(options.state, options.settingsScope);
  const [subscriptions, preferences] = await Promise.all([
    options.state.listSubscriptions(),
    recoverSourceStreamVisits(options.settingsScope, options.state),
  ]);
  return {
    links: reconciled,
    novels,
    subscriptions: await recoverLinkedWorkMetadata(
      options,
      await recoverStreamLibrary(options, subscriptions, preferences),
      reconciled,
      novels,
    ),
    preferences,
  };
}
