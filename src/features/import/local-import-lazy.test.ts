import { afterEach, expect, it, vi } from 'vitest';
import { buildLocalDocumentSeriesImportFile, inspectLocalSeriesImport } from './local-import-lazy';
import type { LocalDocumentSeriesPlan } from './local-document-series-import';

afterEach(() => {
  vi.doUnmock('./local-series-import');
  vi.doUnmock('./local-document-series-import');
  vi.resetModules();
});

it('propagates an unavailable parser chunk and permits a later command after it becomes available', async () => {
  vi.doMock('./local-series-import', () => {
    throw new Error('synthetic chunk unavailable');
  });
  await expect(inspectLocalSeriesImport([], [])).rejects.toMatchObject({
    cause: new Error('synthetic chunk unavailable'),
  });
  const inspect = vi.fn(async () => undefined);
  vi.doMock('./local-series-import', () => ({ inspectLocalSeriesImport: inspect }));
  await expect(inspectLocalSeriesImport([], [])).resolves.toBeUndefined();
  expect(inspect).toHaveBeenCalledOnce();
});

it('does not start an archive build cancelled while its parser chunk loads', async () => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const build = vi.fn();
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.doMock('./local-document-series-import', async () => {
    started();
    await loaded;
    return { buildLocalDocumentSeriesImportFile: build };
  });
  const controller = new AbortController();
  // The plan must never be consumed: cancellation wins before the archive builder runs.
  const pending = buildLocalDocumentSeriesImportFile({} as LocalDocumentSeriesPlan, controller.signal);
  await loading;
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(build).not.toHaveBeenCalled();
});
