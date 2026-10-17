import { usePdfTaskOwner } from './use-pdf-task-owner';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { DocumentAnnotation, DocumentTextBlock, DocumentTextRevision } from '../../domain/types';
import type { DocumentTextRepository } from '../../repositories/document-text-repository';
import type { DocumentAnnotationRepository } from '../../repositories/document-annotation-repository';
import { extractPdfNativeText, pdfNativeTextRevisionId } from './text/pdf-native-text';
import {
  pdfPageHash,
  pdfTextScope,
  publishPdfTextRevision,
  remapPdfTextAnnotations,
  type PdfTextIdentity,
} from './text/pdf-text-publication';
import { needsPdfOcr } from './ocr/ocr-range-plan';

export type PdfTextPageState = 'ready' | 'ocr_candidate' | 'failed';
export function usePdfTextSession(input: {
  novel: PdfTextIdentity;
  pdf?: PDFDocumentProxy;
  pages: ReadonlyMap<number, PDFPageProxy>;
  displayedPageKey: string;
  repository: DocumentTextRepository;
  annotations: DocumentAnnotationRepository;
  onAnnotations(annotations: DocumentAnnotation[]): void;
}) {
  const { novel, pdf, pages, repository, annotations } = input;
  const scope = pdfTextScope(novel);
  const latest = useRef(input);
  latest.current = input;
  const { owner, capture } = usePdfTaskOwner(scope, repository, annotations);
  const extraction = useRef(new Map<string, Promise<void>>());
  const indexJob = useRef<AbortController>();
  const [textBlocksByPage, setBlocks] = useState(new Map<number, DocumentTextBlock[]>());
  const [textPageStates, setStates] = useState(new Map<number, PdfTextPageState>());
  const [readyTextPages, setReadyCount] = useState(0);
  const [interruptedOcrCount, setInterrupted] = useState(0);
  const [textVersion, setVersion] = useState(0);
  const [textIndexProgress, setProgress] = useState<{ current: number; total: number }>();
  useEffect(() => {
    const isCurrent = capture();
    const inFlight = extraction.current;
    setBlocks(new Map());
    setStates(new Map());
    setReadyCount(0);
    setInterrupted(0);
    setProgress(undefined);
    if (novel.format !== 'pdf') return;
    let active = true;
    void Promise.all([repository.recoverInterruptedOcr(novel.id), repository.listReadyRevisions(novel.id)])
      .then(([interrupted, revisions]) => {
        if (!active || !isCurrent()) return;
        setReadyCount(revisions.length);
        setInterrupted(interrupted.length);
        if (interrupted.length) setStates(new Map(interrupted.map((revision) => [revision.pageIndex, 'failed'])));
      })
      .catch(() => undefined);
    return () => {
      active = false;
      inFlight.clear();
      indexJob.current?.abort();
      indexJob.current = undefined;
    };
  }, [owner, novel.id, novel.format, repository, capture]);
  const replacePageBlocks = useCallback(
    (index: number, blocks: DocumentTextBlock[]) => {
      if (!capture()()) return;
      setBlocks((previous) => new Map(previous).set(index, blocks));
      setVersion((value) => value + 1);
    },
    [capture],
  );
  const markPageFailed = useCallback(
    (index: number) => {
      if (capture()()) setStates((previous) => new Map(previous).set(index, 'failed'));
    },
    [capture],
  );
  const publishReady = useCallback(
    async (
      revision: DocumentTextRevision,
      blocks: readonly DocumentTextBlock[],
      options: { pendingRevisionId?: string; signal?: AbortSignal; needsOcr?: boolean } = {},
    ) => {
      const isCurrent = capture();
      if (!isCurrent()) throw new DOMException('Text session changed', 'AbortError');
      const result = await publishPdfTextRevision({ repository, annotations, revision, blocks, ...options });
      if (!isCurrent() || options.signal?.aborted) return;
      setBlocks((previous) => new Map(previous).set(revision.pageIndex, result.blocks));
      setStates((previous) => new Map(previous).set(revision.pageIndex, options.needsOcr ? 'ocr_candidate' : 'ready'));
      setReadyCount(result.readyCount);
      setVersion((value) => value + 1);
      if (result.annotations) latest.current.onAnnotations(result.annotations);
    },
    [repository, annotations, capture],
  );
  const ensurePdfNativeText = useCallback(
    async (index: number, page: PDFPageProxy, signal?: AbortSignal): Promise<void> => {
      const isCurrent = capture();
      const key = `${scope}:${index}`;
      const inFlight = extraction.current.get(key);
      if (inFlight) {
        await inFlight;
        signal?.throwIfAborted();
        return;
      }
      // Native extraction belongs to the document, not the first indexing caller.
      // Cancelling one waiter must not cancel visible-page consumers sharing this promise.
      const current = isCurrent;
      const task = (async () => {
        try {
          if (!current()) return;
          const pageHash = pdfPageHash(novel, index);
          const existing = await repository.findReadyRevision(novel.id, index, pageHash);
          if (!current()) return;
          if (existing && (existing.source === 'ocr' || existing.id === pdfNativeTextRevisionId(novel.id, pageHash))) {
            const [rawBlocks, blocks] = await Promise.all([
              repository.getRawBlocks(existing.id),
              repository.getBlocks(existing.id),
            ]);
            if (!current()) return;
            const remapped = await remapPdfTextAnnotations(annotations, existing, rawBlocks).catch(() => undefined);
            if (!current()) return;
            if (remapped) latest.current.onAnnotations(remapped);
            setBlocks((previous) => new Map(previous).set(index, blocks));
            setStates((previous) =>
              new Map(previous).set(
                index,
                needsPdfOcr({
                  hasRevision: true,
                  characters: rawBlocks.reduce((total, block) => total + block.text.length, 0),
                  qualityScore: existing.qualityScore,
                })
                  ? 'ocr_candidate'
                  : 'ready',
              ),
            );
            return;
          }
          const result = await extractPdfNativeText({ page, bookId: novel.id, pageIndex: index, pageHash });
          if (!current()) return;
          await publishReady(result.revision, result.blocks, { needsOcr: result.needsOcr });
        } catch {
          if (current()) markPageFailed(index);
        }
      })();
      extraction.current.set(key, task);
      try {
        await task;
      } finally {
        if (extraction.current.get(key) === task) extraction.current.delete(key);
      }
      signal?.throwIfAborted();
    },
    [scope, novel, repository, annotations, capture, publishReady, markPageFailed],
  );
  const preparePages = useCallback(
    async (indexes: readonly number[], inspectQuality: boolean): Promise<number[] | undefined> => {
      const isCurrent = capture();
      if (!pdf || indexJob.current || !isCurrent()) return;
      const controller = new AbortController();
      indexJob.current = controller;
      const current = () => isCurrent() && indexJob.current === controller && !controller.signal.aborted;
      setProgress({ current: 0, total: indexes.length });
      const candidates: number[] = [];
      try {
        for (const [offset, index] of indexes.entries()) {
          controller.signal.throwIfAborted();
          const cached = pages.get(index);
          const page = cached ?? (await pdf.getPage(index + 1));
          try {
            controller.signal.throwIfAborted();
            await ensurePdfNativeText(index, page, controller.signal);
          } finally {
            if (!cached) page.cleanup();
          }
          if (!current()) return;
          if (inspectQuality) {
            const revision = await repository.findReadyRevision(novel.id, index, pdfPageHash(novel, index));
            const blocks = revision ? await repository.getBlocks(revision.id) : [];
            if (
              needsPdfOcr({
                hasRevision: Boolean(revision),
                characters: blocks.reduce((total, block) => total + block.text.length, 0),
                qualityScore: revision?.qualityScore,
              })
            )
              candidates.push(index);
          }
          if (!current()) return;
          setProgress({ current: offset + 1, total: indexes.length });
        }
        const revisions = await repository.listReadyRevisions(novel.id);
        if (current()) {
          setReadyCount(revisions.length);
          return candidates;
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
      } finally {
        if (indexJob.current === controller) {
          indexJob.current = undefined;
          if (isCurrent()) setProgress(undefined);
        }
      }
    },
    [pdf, pages, novel, repository, ensurePdfNativeText, capture],
  );
  const indexAllPdfText = useCallback(async () => {
    if (pdf)
      await preparePages(
        Array.from({ length: pdf.numPages }, (_, index) => index),
        false,
      );
  }, [pdf, preparePages]);
  const cancelIndex = useCallback(() => {
    if (capture()()) indexJob.current?.abort();
  }, [capture]);
  useEffect(() => {
    if (novel.format !== 'pdf') return;
    input.displayedPageKey
      .split(',')
      .filter(Boolean)
      .map(Number)
      .forEach((index) => {
        const page = pages.get(index);
        if (page) void ensurePdfNativeText(index, page);
      });
  }, [novel.format, input.displayedPageKey, pages, ensurePdfNativeText]);
  return {
    textBlocksByPage,
    textPageStates,
    readyTextPages,
    interruptedOcrCount,
    textVersion,
    textIndexProgress,
    ensurePdfNativeText,
    indexAllPdfText,
    preparePages,
    cancelIndex,
    publishReady,
    replacePageBlocks,
    markPageFailed,
  };
}
export type PdfTextSession = ReturnType<typeof usePdfTextSession>;
