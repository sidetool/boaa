import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { DocumentTextBlock, DocumentTextRevision } from '../../domain/types';
import type { DocumentTextRepository } from '../../repositories/document-text-repository';
import {
  applyDocumentTextOrderOverride,
  createDocumentTextOrderOverride,
  documentTextBlockFingerprint,
} from '../../domain/document-text-order';
import { pdfPageHash, pdfTextScope, type PdfTextIdentity } from './text/pdf-text-publication';
import { usePdfTaskOwner } from './use-pdf-task-owner';
import type { PdfTextSession } from './use-pdf-text-session';

export function usePdfReadingOrder(input: {
  novel: PdfTextIdentity;
  pdf?: PDFDocumentProxy;
  pages: ReadonlyMap<number, PDFPageProxy>;
  pageIndex: number;
  searchOpen: boolean;
  repository: DocumentTextRepository;
  text: Pick<PdfTextSession, 'ensurePdfNativeText' | 'replacePageBlocks'>;
}) {
  const { novel, pdf, pages, pageIndex, repository } = input;
  const { ensurePdfNativeText, replacePageBlocks } = input.text;
  const { owner, capture } = usePdfTaskOwner(`${pdfTextScope(novel)}:${pageIndex}`, repository, pdf);
  const operation = useRef(0);
  const [readingOrderOpen, setOpen] = useState(false);
  const [readingOrderRevision, setReadingOrderRevision] = useState<DocumentTextRevision>();
  const [readingOrderBlocks, setReadingOrderBlocks] = useState<DocumentTextBlock[]>([]);
  const [readingOrderExcludedIds, setReadingOrderExcludedIds] = useState<Set<string>>(() => new Set());
  const [readingOrderStatus, setReadingOrderStatus] = useState<'idle' | 'loading' | 'saving' | 'failed'>('idle');
  const [readingOrderError, setReadingOrderError] = useState('');
  const setReadingOrderOpen = useCallback(
    (open: boolean) => {
      if (!capture()()) return;
      if (!open) operation.current += 1;
      setOpen(open);
    },
    [capture],
  );
  const begin = useCallback(() => {
    const active = capture();
    if (!active()) return active;
    const id = ++operation.current;
    return () => active() && operation.current === id;
  }, [capture]);
  useEffect(() => {
    operation.current += 1;
    setOpen(false);
    setReadingOrderRevision(undefined);
    setReadingOrderBlocks([]);
    setReadingOrderExcludedIds(new Set());
    setReadingOrderStatus('idle');
    setReadingOrderError('');
  }, [owner]);
  useEffect(() => {
    if (!input.searchOpen) setReadingOrderOpen(false);
  }, [input.searchOpen, setReadingOrderOpen]);
  const openReadingOrderEditor = useCallback(async () => {
    const current = begin();
    if (!current()) return;
    setOpen(true);
    setReadingOrderStatus('loading');
    setReadingOrderError('');
    try {
      const cached = pages.get(pageIndex);
      const page = cached ?? (pdf ? await pdf.getPage(pageIndex + 1) : undefined);
      try {
        if (page) await ensurePdfNativeText(pageIndex, page);
      } finally {
        if (page && !cached) page.cleanup();
      }
      if (!current()) return;
      const revision = await repository.findReadyRevision(novel.id, pageIndex, pdfPageHash(novel, pageIndex));
      if (!current()) return;
      if (!revision) throw new Error('현재 페이지의 텍스트를 먼저 준비해 주세요.');
      const [rawBlocks, override] = await Promise.all([
        repository.getRawBlocks(revision.id),
        repository.getOrderOverride(novel.id, pageIndex),
      ]);
      if (!current()) return;
      if (rawBlocks.length === 0) throw new Error('교정할 텍스트 블록이 없습니다.');
      const excludedFingerprints = new Set(override?.excludedBlockFingerprints ?? []);
      setReadingOrderRevision(revision);
      setReadingOrderBlocks(applyDocumentTextOrderOverride(rawBlocks, override, { includeExcluded: true }));
      setReadingOrderExcludedIds(
        new Set(
          rawBlocks
            .filter((block) => excludedFingerprints.has(documentTextBlockFingerprint(block)))
            .map((block) => block.id),
        ),
      );
      setReadingOrderStatus('idle');
    } catch (error) {
      if (!current()) return;
      setReadingOrderRevision(undefined);
      setReadingOrderBlocks([]);
      setReadingOrderExcludedIds(new Set());
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 불러오지 못했습니다.');
    }
  }, [ensurePdfNativeText, novel, pageIndex, pdf, pages, repository, begin]);

  const moveReadingOrderBlock = useCallback(
    (index: number, delta: -1 | 1) => {
      if (!capture()()) return;
      setReadingOrderBlocks((current) => {
        const target = index + delta;
        if (target < 0 || target >= current.length) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    },
    [capture],
  );

  const toggleReadingOrderExcluded = useCallback(
    (blockId: string) => {
      if (!capture()()) return;
      setReadingOrderExcludedIds((current) => {
        const next = new Set(current);
        if (next.has(blockId)) next.delete(blockId);
        else next.add(blockId);
        return next;
      });
    },
    [capture],
  );

  const saveReadingOrder = useCallback(async () => {
    if (!readingOrderRevision) return;
    const current = begin();
    if (!current()) return;
    setReadingOrderStatus('saving');
    setReadingOrderError('');
    try {
      const existing = await repository.getOrderOverride(novel.id, readingOrderRevision.pageIndex);
      if (!current()) return;
      await repository.saveOrderOverride(
        createDocumentTextOrderOverride({
          revision: readingOrderRevision,
          orderedBlocks: readingOrderBlocks,
          excludedBlockIds: readingOrderExcludedIds,
          existing,
        }),
      );
      const activeBlocks = await repository.getBlocks(readingOrderRevision.id);
      if (!current()) return;
      replacePageBlocks(readingOrderRevision.pageIndex, activeBlocks);
      setReadingOrderStatus('idle');
      setOpen(false);
    } catch (error) {
      if (!current()) return;
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 저장하지 못했습니다.');
    }
  }, [
    novel.id,
    readingOrderBlocks,
    readingOrderExcludedIds,
    readingOrderRevision,
    repository,
    begin,
    replacePageBlocks,
  ]);

  const resetReadingOrder = useCallback(async () => {
    if (!readingOrderRevision) return;
    const current = begin();
    if (!current()) return;
    setReadingOrderStatus('saving');
    setReadingOrderError('');
    try {
      const override = await repository.getOrderOverride(novel.id, readingOrderRevision.pageIndex);
      if (!current()) return;
      if (override) await repository.removeOrderOverride(override.id);
      const rawBlocks = await repository.getRawBlocks(readingOrderRevision.id);
      if (!current()) return;
      replacePageBlocks(readingOrderRevision.pageIndex, rawBlocks);
      setReadingOrderStatus('idle');
      setOpen(false);
    } catch (error) {
      if (!current()) return;
      setReadingOrderStatus('failed');
      setReadingOrderError(error instanceof Error ? error.message : '읽기 순서를 초기화하지 못했습니다.');
    }
  }, [novel.id, readingOrderRevision, repository, begin, replacePageBlocks]);

  return {
    readingOrderOpen,
    setReadingOrderOpen,
    readingOrderRevision,
    readingOrderBlocks,
    readingOrderExcludedIds,
    readingOrderStatus,
    readingOrderError,
    openReadingOrderEditor,
    moveReadingOrderBlock,
    toggleReadingOrderExcluded,
    saveReadingOrder,
    resetReadingOrder,
  };
}
