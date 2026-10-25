import 'fake-indexeddb/auto';
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDbReaderRepository } from '../../repositories/indexeddb-reader-repository';
import { IndexedDbBookAssetRepository } from '../../repositories/indexeddb-book-asset-repository';
import { resetReaderDbForTests } from '../../storage/db';
import { runBrowserFixedDocumentImportPipeline } from '../../services/import/browser-import-pipeline';
import type { ImportService } from '../../services/import/import-service';
import { readLocalSeriesManifest } from './local-series-import';
import { useImportController, type ImportFeatureController } from './useImportController';

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
);
const reader = new IndexedDbReaderRepository();
const assets = new IndexedDbBookAssetRepository();
afterEach(async () => {
  vi.unstubAllGlobals();
  await resetReaderDbForTests();
});

async function release(number: number) {
  const writer = new ZipWriter(new BlobWriter());
  await writer.add(`${number}.png`, new Uint8ArrayReader(PNG));
  return new File([await writer.close()], `순차 작품 ${number}화.cbz`);
}

describe('local chapter sequence through the real browser storage boundary', () => {
  it.each([
    'success',
    'failure',
    'cancel',
    'callback',
    'late_commit_cancel',
    'lookup_cancel',
    'lookup_failure',
    'lookup_missing',
    'replan_missing',
  ] as const)(
    'retains the target and completed chapter after %s and retries without duplication',
    async (mode) => {
      vi.stubGlobal('window', globalThis);
      let controller!: ImportFeatureController;
      let attempts = 0;
      let refreshAttempts = 0;
      let cancelLookup = true;
      let failLookup = true;
      let lookupCalls = 0;
      const onImportCommitted = vi.fn(async () => {
        if (mode === 'callback' && ++refreshAttempts <= 2)
          throw new DOMException('temporary refresh error', 'AbortError');
      });
      const requests: Parameters<ImportService['importFile']>[0][] = [];
      const importFile: ImportService['importFile'] = (input, onProgress) => {
        requests.push(input);
        attempts++;
        const failing = attempts === 2 && (mode === 'failure' || mode === 'cancel');
        return {
          jobId: `job-${attempts}`,
          cancel: vi.fn(),
          promise: (async () => {
            if (failing) {
              if (mode === 'cancel') {
                controller.cancelImport();
                throw new DOMException('Cancelled', 'AbortError');
              }
              throw new Error('fixture import failed');
            }
            const result = await runBrowserFixedDocumentImportPipeline({
              ...input,
              fileName: input.file.name,
              sourceBlob: input.file,
              buffer: new ArrayBuffer(0),
              totalBytes: input.file.size,
              jobId: `job-${attempts}`,
              onProgress,
            });
            if (mode === 'late_commit_cancel' && attempts === 1) controller.cancelImport();
            return result;
          })(),
        };
      };
      function Harness() {
        controller = useImportController({
          importService: { importFile, supportsIncrementalImageSeriesAppend: true },
          assets,
          getNovel: async (id) => {
            lookupCalls += 1;
            if (mode === 'replan_missing' && attempts === 1 && lookupCalls === 2) return undefined;
            if ((mode === 'lookup_failure' || mode === 'lookup_missing') && attempts === 1 && failLookup) {
              failLookup = false;
              if (mode === 'lookup_failure') throw new Error('temporary canonical lookup failure');
              return undefined;
            }
            const novel = await reader.getNovel(id);
            if (mode === 'lookup_cancel' && attempts === 1 && cancelLookup) {
              cancelLookup = false;
              controller.cancelImport();
            }
            return novel;
          },
          listNovels: () => reader.listNovels(),
          listChapters: (id) => reader.listChapters(id),
          onImportCommitted,
          notify: vi.fn(),
        });
        return null;
      }
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Harness />);
      });
      try {
        const count = mode === 'success' ? 101 : 2;
        const files: File[] = [];
        for (let number = 1; number <= count; number++) files.push(await release(number));
        await act(async () => controller.selectFiles(files));
        for (let i = 0; i < 100 && (!controller.seriesPlan || controller.seriesBusy); i++)
          await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
        expect(controller.seriesPlan?.addCount).toBe(count);
        await act(async () => controller.startPendingImport());
        const first = (await reader.listNovels())[0]!;
        expect(await reader.listNovels()).toHaveLength(1);
        if (
          mode === 'failure' ||
          mode === 'cancel' ||
          mode === 'late_commit_cancel' ||
          mode === 'lookup_cancel' ||
          mode === 'lookup_failure' ||
          mode === 'lookup_missing' ||
          mode === 'replan_missing'
        ) {
          expect(await reader.listChapters(first.id)).toHaveLength(1);
          expect(controller.seriesPlan).toMatchObject({
            targetNovel: { id: first.id },
            addCount: 1,
            duplicateCount: 1,
          });
          expect(controller.seriesTargetLocked).toBe(true);
          expect(controller.isOpen).toBe(true);
          if (mode === 'replan_missing') {
            expect(requests).toHaveLength(1);
            expect(controller.batch).toMatchObject({ completed: 1, failed: 1 });
          }
          if (mode === 'lookup_failure' || mode === 'lookup_missing') {
            expect(controller.batch).toMatchObject({ completed: 1, failed: 0 });
            expect(controller.refreshPendingBooks).toHaveLength(1);
            expect(onImportCommitted).not.toHaveBeenCalled();
            await act(async () => controller.retryPendingRefresh?.());
            expect(onImportCommitted).toHaveBeenCalledOnce();
            expect(onImportCommitted).toHaveBeenCalledWith(
              expect.objectContaining({ id: first.id, activeContentRevisionId: first.activeContentRevisionId }),
            );
            expect(requests).toHaveLength(1);
          }
          await act(async () => controller.startPendingImport());
        }
        expect(await reader.listNovels()).toHaveLength(1);
        expect(await reader.listChapters(first.id)).toHaveLength(count);
        expect(requests).toHaveLength(
          mode === 'success' ||
            mode === 'callback' ||
            mode === 'late_commit_cancel' ||
            mode === 'lookup_cancel' ||
            mode === 'lookup_failure' ||
            mode === 'lookup_missing' ||
            mode === 'replan_missing'
            ? count
            : 3,
        );
        expect(requests[1]).toMatchObject({ clientBookId: first.id, importMode: 'append_image_series' });
        if (requests[2])
          expect(requests[2]).toMatchObject({ clientBookId: first.id, importMode: 'append_image_series' });
        for (const request of requests) expect((await readLocalSeriesManifest(request.file))?.chapters).toHaveLength(1);
        if (mode === 'callback') {
          expect(controller.batch).toMatchObject({ completed: count, failed: 0 });
          expect(controller.refreshPendingBooks).toHaveLength(1);
          await act(async () => controller.retryPendingRefresh?.());
          expect(controller.refreshPendingBooks).toEqual([]);
          expect(requests).toHaveLength(count);
          await act(async () => controller.close());
        }
        expect(controller.isOpen).toBe(false);
        expect(controller.seriesTargetLocked).toBe(false);
        const unrelated = new File(['다른 소설의 본문'], '다른 작품.txt');
        await act(async () => controller.selectFiles([unrelated]));
        expect(controller.pendingFiles).toEqual([unrelated]);
        expect(controller.seriesTargetNovelId).toBeUndefined();
      } finally {
        await act(async () => renderer.unmount());
      }
    },
    // This is a 101-archive persistence/identity acceptance test, not a latency benchmark.
    120_000,
  );
});
