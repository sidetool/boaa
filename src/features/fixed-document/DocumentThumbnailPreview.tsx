import { useEffect, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import {
  getDocumentThumbnail,
  pruneDocumentThumbnails,
  saveDocumentThumbnail,
} from '../../storage/document-thumbnail-store';
import { archiveThumbnailFingerprint, archiveThumbnailPageHash, renderArchiveThumbnail } from './archive-thumbnail';
import { pdfThumbnailFingerprint, renderPdfThumbnail } from './pdf-thumbnail';
import type { ComicPageLayoutHint } from './comic-layout';

// Each mounted thumbnail owns its render cancellation and object URL lifetime.
export function PdfThumbnailPreview({
  page,
  bookId,
  pageIndex,
  pageHash,
}: {
  readonly page: PDFPageProxy;
  readonly bookId: string;
  readonly pageIndex: number;
  readonly pageHash: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const renderFingerprint = pdfThumbnailFingerprint();
      const cached = await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint });
      let blob = cached?.blob;
      if (!blob) {
        const rendered = await renderPdfThumbnail(page, controller.signal);
        blob = rendered.blob;
        await saveDocumentThumbnail({
          bookId,
          pageIndex,
          pageHash,
          renderFingerprint: rendered.renderFingerprint,
          contentType: rendered.contentType,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
          blob,
        }).catch(() => undefined);
        void pruneDocumentThumbnails(bookId).catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bookId, page, pageHash, pageIndex]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}

export function ArchiveThumbnailPreview({
  bookId,
  sourceIdentity,
  chapterId,
  pageIndex,
  repository,
  assets,
  onPageHint,
  persistent = true,
}: {
  readonly persistent?: boolean;
  readonly bookId: string;
  readonly sourceIdentity: string;
  readonly chapterId: string;
  readonly pageIndex: number;
  readonly repository: Pick<ReaderRepository, 'getParagraphPage'>;
  readonly assets: Pick<BookAssetRepository, 'getEmbeddedResource' | 'openSource' | 'saveGeneratedCover'>;
  readonly onPageHint: (pageIndex: number, hint: ComicPageLayoutHint) => void;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      const paragraphPage = await repository.getParagraphPage(chapterId, 0, controller.signal);
      const paragraph = paragraphPage?.paragraphs[0];
      if (paragraph?.documentPageType !== undefined || paragraph?.documentPageDouble !== undefined) {
        onPageHint(pageIndex, {
          type: paragraph.documentPageType,
          doublePage: paragraph.documentPageDouble,
        });
      }
      const assetId = paragraph?.assetId;
      if (!assetId) throw new Error('이미지 페이지 정보를 찾을 수 없습니다.');
      const pageHash = archiveThumbnailPageHash(assetId, pageIndex);
      const renderFingerprint = archiveThumbnailFingerprint();
      const cached = persistent
        ? await getDocumentThumbnail({ bookId, pageIndex, pageHash, renderFingerprint })
        : undefined;
      let blob = cached?.blob;
      if (!blob) {
        const resource = await assets.getEmbeddedResource(bookId, assetId, controller.signal);
        if (!resource) throw new Error('이미지 페이지를 찾을 수 없습니다.');
        const rendered = await renderArchiveThumbnail(resource.blob, controller.signal);
        blob = rendered.blob;
        controller.signal.throwIfAborted();
        if (persistent) {
          await saveDocumentThumbnail({
            bookId,
            pageIndex,
            pageHash,
            renderFingerprint: rendered.renderFingerprint,
            contentType: rendered.contentType,
            pixelWidth: rendered.pixelWidth,
            pixelHeight: rendered.pixelHeight,
            blob,
          }).catch(() => undefined);
          void pruneDocumentThumbnails(bookId).catch(() => undefined);
        }
      }
      controller.signal.throwIfAborted();
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assets, bookId, chapterId, onPageHint, pageIndex, repository, sourceIdentity, persistent]);
  return url ? <img src={url} alt="" draggable={false} /> : <span>{pageIndex + 1}</span>;
}
