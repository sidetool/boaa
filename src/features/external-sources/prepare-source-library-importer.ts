/** Warm code only; no extension requests or downloads until the import lane admits an episode. */
export function prepareSourceLibraryImporter(): Promise<unknown> {
  return Promise.all([
    import('../../external-sources/series/series-download-queue'),
    import('../../external-sources/series/hosted-image-download-queue'),
    import('../../external-sources/series/document-series-import-coordinator'),
  ]);
}
