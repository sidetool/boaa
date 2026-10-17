import {
  buildSeriesImageArchive as buildSharedSeriesImageArchive,
  mergeSeriesImageArchiveDelta,
  readSeriesImageArchiveManifest,
} from '@boaa/fixed-document-core/series-image-archive';
import type {
  SeriesImageArchiveInput,
  SeriesImageArchiveStreamOpener,
} from '@boaa/fixed-document-core/series-image-archive';

export * from '@boaa/fixed-document-core/series-image-archive';

/** Browser/local adapter for decoding ZIP, RAR and 7z chapter archives. */
export function buildSeriesImageArchive(input: SeriesImageArchiveInput): Promise<File> {
  const openImageArchiveStream: SeriesImageArchiveStreamOpener = async (file, options) => {
    const fixedDocumentCore = await import('@boaa/fixed-document-core');
    return fixedDocumentCore.openImageArchiveStream(file, options);
  };
  return buildSharedSeriesImageArchive({ ...input, openImageArchiveStream });
}

export { mergeSeriesImageArchiveDelta, readSeriesImageArchiveManifest };
