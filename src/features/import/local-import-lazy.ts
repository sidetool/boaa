/** Load archive parsers only after an import command, without retaining an extra rejected-promise cache. */

export async function inspectLocalSeriesImport(
  ...args: Parameters<(typeof import('./local-series-import'))['inspectLocalSeriesImport']>
) {
  const module = await import('./local-series-import');

  return module.inspectLocalSeriesImport(...args);
}

export async function planLocalSeriesImport(
  ...args: Parameters<(typeof import('./local-series-import'))['planLocalSeriesImport']>
) {
  const module = await import('./local-series-import');

  return module.planLocalSeriesImport(...args);
}

export async function inspectLocalDocumentSeriesImport(
  ...args: Parameters<(typeof import('./local-document-series-import'))['inspectLocalDocumentSeriesImport']>
) {
  const module = await import('./local-document-series-import');

  return module.inspectLocalDocumentSeriesImport(...args);
}

export async function planLocalDocumentSeriesImport(
  ...args: Parameters<(typeof import('./local-document-series-import'))['planLocalDocumentSeriesImport']>
) {
  const module = await import('./local-document-series-import');

  return module.planLocalDocumentSeriesImport(...args);
}

export async function buildLocalDocumentSeriesImportFile(
  ...args: Parameters<(typeof import('./local-document-series-import'))['buildLocalDocumentSeriesImportFile']>
) {
  args[1]?.throwIfAborted();
  const module = await import('./local-document-series-import');
  args[1]?.throwIfAborted();
  return module.buildLocalDocumentSeriesImportFile(...args);
}

export async function runLocalSeriesImport(
  ...args: Parameters<(typeof import('./local-series-import-runner'))['runLocalSeriesImport']>
) {
  args[0].signal.throwIfAborted();
  const module = await import('./local-series-import-runner');
  args[0].signal.throwIfAborted();
  return module.runLocalSeriesImport(...args);
}
