import { useEffect, useRef, useState } from 'react';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { BookAssetRepository, RandomAccessBookSource } from '../../repositories/book-asset-repository';
import { BookSourcePdfRangeTransport } from './pdf-range-transport';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const EMPTY_PAGES = new Map<number, PDFPageProxy>();
type Status = 'loading' | 'ready' | 'failed';

/** Owns the range source and PDF.js loading task, including cancellation before the document exists. */
export function usePdfDocumentSession(input: {
  enabled: boolean;
  bookId: string;
  sourceRevision: string;
  assets: Pick<BookAssetRepository, 'openSource'>;
  currentPage: number;
  totalPages: number;
  wantedPages: ReadonlySet<number>;
}) {
  const { enabled, bookId, sourceRevision, assets } = input;
  const key = JSON.stringify([bookId, sourceRevision]);
  const [state, setState] = useState<{
    key: string;
    assets: typeof assets;
    pdf?: PDFDocumentProxy;
    status: Status;
    errorMessage: string;
  }>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pendingSource: RandomAccessBookSource | undefined;
    let range: BookSourcePdfRangeTransport | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (range) range.abort();
      else if (pendingSource) void pendingSource.close().catch(() => undefined);
      if (task) void task.destroy().catch(() => undefined);
    };
    setState({ key, assets, status: 'loading', errorMessage: '' });
    void (async () => {
      const source = await assets.openSource(bookId);
      if (disposed) {
        await source?.close();
        return;
      }
      if (!source) throw new Error('PDF 원본을 찾을 수 없습니다. 원본 파일을 다시 연결해 주세요.');
      // The initial read and range transport overlap across an await boundary.
      // Both owners may dispose in that gap, but the underlying handle closes once.
      let closing: Promise<void> | undefined;
      pendingSource = {
        byteLength: source.byteLength,
        contentType: source.contentType,
        contentHash: source.contentHash,
        readRange: (start, end, signal) => source.readRange(start, end, signal),
        close: () => (closing ??= source.close()),
      };
      range = await BookSourcePdfRangeTransport.open(pendingSource, 64 * 1024, controller.signal);
      pendingSource = undefined;
      if (disposed) {
        range.abort();
        return;
      }
      task = getDocument({ range, rangeChunkSize: 64 * 1024, disableAutoFetch: true, disableStream: true });
      const pdf = await task.promise;
      if (!disposed) setState({ key, assets, pdf, status: 'ready', errorMessage: '' });
    })().catch((error: unknown) => {
      if (disposed) return;
      setState({
        key,
        assets,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'PDF를 열지 못했습니다.',
      });
      dispose();
    });
    return dispose;
  }, [enabled, bookId, key, assets]);
  const current = enabled && state?.key === key && state.assets === assets ? state : undefined;
  const pages = usePdfPageCache(current?.pdf, input.currentPage, input.totalPages, input.wantedPages);
  return {
    pdf: current?.pdf,
    pdfPages: pages,
    status: current?.status ?? 'loading',
    errorMessage: current?.errorMessage ?? '',
  };
}

/** Cache lifetime follows the document; navigation changes keep wanted pages and the ±3 neighbourhood. */
function usePdfPageCache(
  pdf: PDFDocumentProxy | undefined,
  currentPage: number,
  totalPages: number,
  wanted: ReadonlySet<number>,
) {
  const [snapshot, setSnapshot] = useState<{ pdf: PDFDocumentProxy; pages: Map<number, PDFPageProxy> }>();
  const sessionRef = useRef<{
    pdf: PDFDocumentProxy;
    active: boolean;
    pages: Map<number, PDFPageProxy>;
    pending: Set<number>;
  }>();
  const planRef = useRef({ currentPage, wanted });
  planRef.current = { currentPage, wanted };
  const wantedKey = [...wanted].join(',');
  useEffect(() => {
    if (!pdf) return;
    const session = { pdf, active: true, pages: new Map<number, PDFPageProxy>(), pending: new Set<number>() };
    sessionRef.current = session;
    setSnapshot({ pdf, pages: new Map() });
    return () => {
      session.active = false;
      for (const page of session.pages.values()) page.cleanup();
      session.pages.clear();
      if (sessionRef.current === session) sessionRef.current = undefined;
    };
  }, [pdf]);
  useEffect(() => {
    const session = sessionRef.current;
    if (!pdf || !session || session.pdf !== pdf) return;
    const publish = () => {
      const plan = planRef.current;
      if (session.pages.size > 20)
        for (const [index, page] of session.pages) {
          if (plan.wanted.has(index) || Math.abs(index - plan.currentPage) <= 3) continue;
          page.cleanup();
          session.pages.delete(index);
        }
      setSnapshot({ pdf, pages: new Map(session.pages) });
    };
    publish();
    for (const index of wantedKey.split(',').filter(Boolean).map(Number)) {
      if (index < 0 || index >= totalPages || session.pages.has(index) || session.pending.has(index)) continue;
      session.pending.add(index);
      void pdf
        .getPage(index + 1)
        .then((page) => {
          if (!session.active) {
            page.cleanup();
            return;
          }
          session.pages.set(index, page);
          publish();
        })
        .catch(() => {
          // Document opening reports failures; a later navigation may retry a page fetch.
        })
        .finally(() => session.pending.delete(index));
    }
  }, [pdf, currentPage, totalPages, wantedKey]);
  return snapshot && snapshot.pdf === pdf ? snapshot.pages : EMPTY_PAGES;
}
