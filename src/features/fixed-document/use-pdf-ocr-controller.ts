import { usePdfTaskOwner } from './use-pdf-task-owner';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { DocumentTextRevision } from '../../domain/types';
import type { DocumentTextRepository } from '../../repositories/document-text-repository';
import { persistentId128 } from '@boaa/text-core/hash';
import { LocalTesseractOcrProvider } from '../../providers/local-tesseract-ocr-provider';
import { buildOcrDocumentText, rasterizePdfPageForOcr } from './ocr/pdf-ocr';
import {
  inspectOcrLanguageModelCache,
  removeOcrLanguageModelCache,
  type OcrLanguageModel,
  type OcrLanguageModelCacheEntry,
} from './ocr/ocr-language-model-cache';
import { normalizeOcrPageRange } from './ocr/ocr-range-plan';
import { pdfPageHash, pdfTextScope, type PdfTextIdentity } from './text/pdf-text-publication';
import type { PdfTextSession } from './use-pdf-text-session';

function pendingOcrRevision(novel: PdfTextIdentity, pageIndex: number, language: string): DocumentTextRevision {
  const timestamp = new Date().toISOString();
  const pageHash = pdfPageHash(novel, pageIndex);
  return {
    id: persistentId128('document_text_revision', [
      novel.id,
      pageHash,
      'ocr',
      'local-tesseract-v7',
      language,
      'pending',
    ]),
    bookId: novel.id,
    pageIndex,
    pageHash,
    source: 'ocr',
    engine: 'local-tesseract-v7',
    engineVersion: 'pending',
    language,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export function usePdfOcrController(input: {
  novel: PdfTextIdentity;
  pdf?: PDFDocumentProxy;
  pages: ReadonlyMap<number, PDFPageProxy>;
  pageIndex: number;
  totalPages: number;
  searchOpen: boolean;
  repository: DocumentTextRepository;
  text: Pick<
    PdfTextSession,
    'publishReady' | 'markPageFailed' | 'preparePages' | 'textIndexProgress' | 'interruptedOcrCount'
  >;
}) {
  const { novel, pdf, pages, repository, text } = input;
  const scope = pdfTextScope(novel);
  const { owner, capture } = usePdfTaskOwner(scope, repository, pdf);
  const job = useRef<AbortController>();
  const providerRef = useRef<LocalTesseractOcrProvider>();
  const modelRequest = useRef(0);
  const [ocrLanguage, setOcrLanguage] = useState('kor+eng');
  const [ocrRangeStart, setOcrRangeStart] = useState(input.pageIndex + 1);
  const [ocrRangeEnd, setOcrRangeEnd] = useState(Math.min(input.totalPages, input.pageIndex + 10));
  const [ocrWorkerLanguage, setOcrWorkerLanguage] = useState<string>();
  const [ocrProgress, setOcrProgress] = useState<{
    pageIndex: number;
    progress: number;
    status: string;
    current: number;
    total: number;
  }>();
  const [ocrError, setOcrError] = useState('');
  const [ocrModelCache, setOcrModelCache] = useState<OcrLanguageModelCacheEntry[]>([]);
  const [ocrModelCacheStatus, setOcrModelCacheStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [ocrModelCacheError, setOcrModelCacheError] = useState('');
  useEffect(() => {
    setOcrError('');
    setOcrProgress(undefined);
    setOcrWorkerLanguage(undefined);
    return () => {
      modelRequest.current += 1;
      job.current?.abort();
      job.current = undefined;
      const provider = providerRef.current;
      providerRef.current = undefined;
      if (provider) void provider.dispose();
    };
  }, [owner]);
  useEffect(() => {
    if (text.interruptedOcrCount)
      setOcrError(`이전에 중단된 OCR ${text.interruptedOcrCount}페이지를 다시 실행할 수 있습니다.`);
  }, [text.interruptedOcrCount]);
  const refreshOcrModelCache = useCallback(async () => {
    const isCurrent = capture();
    if (!isCurrent()) return;
    const request = ++modelRequest.current;
    setOcrModelCacheStatus('loading');
    setOcrModelCacheError('');
    try {
      const models = await inspectOcrLanguageModelCache();
      if (!isCurrent() || request !== modelRequest.current) return;
      setOcrModelCache(models);
      setOcrModelCacheStatus('ready');
    } catch (error) {
      if (!isCurrent() || request !== modelRequest.current) return;
      setOcrModelCacheStatus('failed');
      setOcrModelCacheError(error instanceof Error ? error.message : 'OCR 언어 데이터 상태를 확인하지 못했습니다.');
    }
  }, [capture]);
  useEffect(() => {
    if (input.searchOpen && novel.format === 'pdf') void refreshOcrModelCache();
  }, [input.searchOpen, novel.format, refreshOcrModelCache]);
  const recognizePdfPage = useCallback(
    async (index: number, signal: AbortSignal, current: number, total: number) => {
      const isCurrent = capture();
      if (!pdf || !isCurrent()) return;
      signal.throwIfAborted();
      const cached = pages.get(index);
      const page = cached ?? (await pdf.getPage(index + 1));
      const pending = pendingOcrRevision(novel, index, ocrLanguage);
      let provider: LocalTesseractOcrProvider | undefined;
      const live = () => isCurrent() && !signal.aborted;
      try {
        signal.throwIfAborted();
        await repository.saveRevision(pending);
        signal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('OCR session changed', 'AbortError');
        setOcrProgress({ pageIndex: index, progress: 0, status: '페이지 준비', current, total });
        const raster = await rasterizePdfPageForOcr(page);
        signal.throwIfAborted();
        provider = providerRef.current ??= new LocalTesseractOcrProvider();
        const result = await provider.recognize(
          {
            ...raster,
            language: ocrLanguage,
            onProgress: (progress, status) => {
              if (live()) setOcrProgress({ pageIndex: index, progress, status, current, total });
            },
          },
          signal,
        );
        signal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('OCR session changed', 'AbortError');
        setOcrWorkerLanguage(ocrLanguage);
        const built = buildOcrDocumentText({
          result,
          bookId: novel.id,
          pageIndex: index,
          pageHash: pdfPageHash(novel, index),
          pixelWidth: raster.pixelWidth,
          pixelHeight: raster.pixelHeight,
          dpi: raster.dpi,
        });
        if (!built.blocks.length) throw new Error('인식된 텍스트가 없습니다.');
        await text.publishReady(built.revision, built.blocks, { pendingRevisionId: pending.id, signal });
      } catch (error) {
        const message =
          error instanceof Error && error.name === 'AbortError'
            ? 'OCR 작업이 취소되었습니다.'
            : error instanceof Error
              ? error.message
              : 'OCR을 완료하지 못했습니다.';
        await repository.markRevisionStatus(pending.id, 'failed', message).catch(() => undefined);
        if (live()) text.markPageFailed(index);
        throw error;
      } finally {
        if (!cached) page.cleanup();
        // A provider may finish creating its worker after cancellation; retire that late worker too.
        if (provider && (!isCurrent() || signal.aborted)) {
          if (providerRef.current === provider) providerRef.current = undefined;
          await provider.dispose();
        }
      }
    },
    [novel, pdf, pages, repository, text, ocrLanguage, capture],
  );
  const runOcrPages = useCallback(
    async (indexes: readonly number[]) => {
      const isCurrent = capture();
      if (!indexes.length || job.current || !isCurrent()) return;
      const controller = new AbortController();
      job.current = controller;
      setOcrError('');
      try {
        for (const [offset, index] of indexes.entries()) {
          controller.signal.throwIfAborted();
          await recognizePdfPage(index, controller.signal, offset + 1, indexes.length);
        }
      } catch (error) {
        if (isCurrent() && (!(error instanceof Error) || error.name !== 'AbortError'))
          setOcrError(error instanceof Error ? error.message : 'OCR을 완료하지 못했습니다.');
      } finally {
        if (job.current === controller) {
          job.current = undefined;
          if (isCurrent()) {
            setOcrProgress(undefined);
            await refreshOcrModelCache();
          }
        }
      }
    },
    [recognizePdfPage, refreshOcrModelCache, capture],
  );
  const runOcrRange = useCallback(async () => {
    const isCurrent = capture();
    if (!pdf || !isCurrent() || text.textIndexProgress || job.current) return;
    setOcrError('');
    try {
      const range = normalizeOcrPageRange(ocrRangeStart, ocrRangeEnd, pdf.numPages);
      const candidates = await text.preparePages(range.pageIndexes, true);
      if (!isCurrent() || !candidates) return;
      if (!candidates.length) {
        setOcrError('선택 범위의 native text 품질이 충분해 OCR할 페이지가 없습니다.');
        return;
      }
      await runOcrPages(candidates);
    } catch (error) {
      if (isCurrent()) setOcrError(error instanceof Error ? error.message : 'OCR 범위를 준비하지 못했습니다.');
    }
  }, [pdf, text, ocrRangeStart, ocrRangeEnd, capture, runOcrPages]);
  const cancelOcr = useCallback(() => {
    if (capture()()) job.current?.abort();
  }, [capture]);
  const unloadOcrWorker = useCallback(async () => {
    const isCurrent = capture();
    if (!isCurrent()) return;
    job.current?.abort();
    const provider = providerRef.current;
    providerRef.current = undefined;
    if (provider) await provider.dispose();
    if (isCurrent()) setOcrWorkerLanguage(undefined);
  }, [capture]);
  const removeOcrModel = useCallback(
    async (language: OcrLanguageModel) => {
      const isCurrent = capture();
      if (!isCurrent() || job.current || ocrModelCacheStatus === 'loading') return;
      setOcrModelCacheStatus('loading');
      setOcrModelCacheError('');
      try {
        await unloadOcrWorker();
        if (!isCurrent()) return;
        await removeOcrLanguageModelCache([language]);
        if (isCurrent()) await refreshOcrModelCache();
      } catch (error) {
        if (isCurrent()) {
          setOcrModelCacheStatus('failed');
          setOcrModelCacheError(error instanceof Error ? error.message : 'OCR 언어 데이터를 삭제하지 못했습니다.');
        }
      }
    },
    [ocrModelCacheStatus, unloadOcrWorker, refreshOcrModelCache, capture],
  );
  return {
    ocrLanguage,
    setOcrLanguage,
    ocrRangeStart,
    setOcrRangeStart,
    ocrRangeEnd,
    setOcrRangeEnd,
    ocrWorkerLanguage,
    ocrProgress,
    ocrError,
    ocrModelCache,
    ocrModelCacheStatus,
    ocrModelCacheError,
    runOcrPages,
    runOcrRange,
    cancelOcr,
    unloadOcrWorker,
    removeOcrModel,
    refreshOcrModelCache,
  };
}
