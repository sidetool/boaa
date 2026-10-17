import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { ComicReadingProfile, DocumentAnnotation, DocumentTextBlock } from '../../domain/types';
import { buildFixedTextSelection, type FixedTextSelectionRange } from './text/fixed-text-selection';

export interface PdfTextSelection {
  readonly pageIndex: number;
  readonly textRevisionId: string;
  readonly ranges: readonly FixedTextSelectionRange[];
  readonly quote: string;
  readonly quads: readonly DocumentTextBlock['quads'][number][];
}

export interface PdfRegionSelection {
  readonly pageIndex: number;
  readonly quad: { x: number; y: number; width: number; height: number };
}

function rotateTextQuad(quad: DocumentTextBlock['quads'][number], rotation: number) {
  if (rotation === 90) {
    return { x: 1 - quad.y - quad.height, y: quad.x, width: quad.height, height: quad.width };
  }
  if (rotation === 180) {
    return { x: 1 - quad.x - quad.width, y: 1 - quad.y - quad.height, width: quad.width, height: quad.height };
  }
  if (rotation === 270) {
    return { x: quad.y, y: 1 - quad.x - quad.width, width: quad.height, height: quad.width };
  }
  return quad;
}

function unrotateTextQuad(quad: DocumentTextBlock['quads'][number], rotation: number) {
  return rotateTextQuad(quad, (360 - rotation) % 360);
}

export function PdfPageView({
  page,
  fit,
  zoom,
  rotation,
  availableWidth,
  availableHeight,
  textBlocks = [],
  selectionEnabled = false,
  searchQuery = '',
  pageIndex,
  annotations = [],
  onTextSelection,
  regionSelectionEnabled = false,
  onRegionSelection,
  activeRange,
}: {
  page?: PDFPageProxy;
  fit: ComicReadingProfile['fit'];
  zoom: number;
  rotation: number;
  availableWidth: number;
  availableHeight: number;
  textBlocks?: readonly DocumentTextBlock[];
  selectionEnabled?: boolean;
  searchQuery?: string;
  pageIndex: number;
  annotations?: readonly DocumentAnnotation[];
  onTextSelection?: (selection: PdfTextSelection) => void;
  regionSelectionEnabled?: boolean;
  onRegionSelection?: (selection: PdfRegionSelection) => void;
  activeRange?: { readonly blockId: string; readonly startOffset: number; readonly endOffset: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [regionDrag, setRegionDrag] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  }>();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    const base = page.getViewport({ scale: 1, rotation });
    const widthScale = Math.max(0.1, availableWidth / base.width);
    const heightScale = Math.max(0.1, availableHeight / base.height);
    const fitScale =
      fit === 'width'
        ? widthScale
        : fit === 'height'
          ? heightScale
          : fit === 'original'
            ? 1
            : Math.min(widthScale, heightScale);
    const scale = fitScale * zoom;
    const viewport = page.getViewport({ scale, rotation });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2.5);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    setCanvasSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    void task.promise.catch((error) => {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
    });
    return () => task.cancel();
  }, [availableHeight, availableWidth, fit, page, rotation, zoom]);
  const needle = searchQuery.normalize('NFKC').toLocaleLowerCase().trim();
  const selectionFinished = () => {
    if (!selectionEnabled || !onTextSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const startSpan =
      range.startContainer.parentElement?.closest<HTMLElement>('[data-document-block-id]') ??
      (range.startContainer instanceof HTMLElement
        ? range.startContainer.closest<HTMLElement>('[data-document-block-id]')
        : null);
    const endSpan =
      range.endContainer.parentElement?.closest<HTMLElement>('[data-document-block-id]') ??
      (range.endContainer instanceof HTMLElement
        ? range.endContainer.closest<HTMLElement>('[data-document-block-id]')
        : null);
    if (!startSpan || !endSpan) return;
    const offsetWithin = (span: HTMLElement, container: Node, offset: number) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(span);
      prefix.setEnd(container, offset);
      return prefix.toString().length;
    };
    const built = buildFixedTextSelection({
      blocks: textBlocks,
      startBlockId: startSpan.dataset.documentBlockId ?? '',
      startOffset: offsetWithin(startSpan, range.startContainer, range.startOffset),
      endBlockId: endSpan.dataset.documentBlockId ?? '',
      endOffset: offsetWithin(endSpan, range.endContainer, range.endOffset),
    });
    const first = built?.ranges[0];
    if (!built || !first) return;
    onTextSelection({
      pageIndex,
      textRevisionId: first.block.revisionId,
      ranges: built.ranges,
      quote: built.quote,
      quads: built.quads,
    });
  };
  const regionPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    };
  };
  const startRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = regionPoint(event);
    setRegionDrag({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
  };
  const moveRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionDrag || !regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    const point = regionPoint(event);
    setRegionDrag((current) => current && { ...current, currentX: point.x, currentY: point.y });
  };
  const finishRegionSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionDrag || !regionSelectionEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    const point = regionPoint(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const displayed = {
      x: Math.min(regionDrag.startX, point.x),
      y: Math.min(regionDrag.startY, point.y),
      width: Math.abs(point.x - regionDrag.startX),
      height: Math.abs(point.y - regionDrag.startY),
    };
    setRegionDrag(undefined);
    if (displayed.width < 0.01 || displayed.height < 0.01) return;
    onRegionSelection?.({ pageIndex, quad: unrotateTextQuad(displayed, rotation) });
  };
  return (
    <div className="fixed-doc-pdf-page" style={canvasSize}>
      <canvas ref={canvasRef} className="fixed-doc-canvas" />
      {textBlocks.length > 0 && (
        <div
          className={`fixed-doc-text-layer${selectionEnabled ? ' is-selectable' : ''}`}
          aria-label="PDF 텍스트 계층"
          onPointerUp={selectionFinished}
        >
          {textBlocks.map((block) => {
            const quads = block.quads.map((quad) => rotateTextQuad(quad, rotation));
            const x = Math.min(...quads.map((quad) => quad.x));
            const y = Math.min(...quads.map((quad) => quad.y));
            const right = Math.max(...quads.map((quad) => quad.x + quad.width));
            const bottom = Math.max(...quads.map((quad) => quad.y + quad.height));
            const matched = Boolean(needle && block.normalizedText.includes(needle));
            const active = block.id === activeRange?.blockId;
            const activeStartRatio = active
              ? Math.max(0, Math.min(1, activeRange.startOffset / Math.max(1, block.text.length)))
              : 0;
            const activeEndRatio = active
              ? Math.max(activeStartRatio, Math.min(1, activeRange.endOffset / Math.max(1, block.text.length)))
              : 1;
            const activeFrom = block.direction === 'rtl' ? 1 - activeEndRatio : activeStartRatio;
            const activeTo = block.direction === 'rtl' ? 1 - activeStartRatio : activeEndRatio;
            return (
              <span
                key={block.id}
                data-document-block-id={block.id}
                className={`${matched ? 'is-search-hit' : ''}${active ? ' is-tts-active' : ''}`}
                dir={block.direction === 'rtl' ? 'rtl' : 'ltr'}
                style={{
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  width: `${Math.max(0.2, (right - x) * 100)}%`,
                  height: `${Math.max(0.2, (bottom - y) * 100)}%`,
                  fontSize: `${Math.max(4, (bottom - y) * canvasSize.height * 0.85)}px`,
                  background: active
                    ? `linear-gradient(to right, transparent ${activeFrom * 100}%, rgba(177, 69, 49, 0.28) ${activeFrom * 100}%, rgba(177, 69, 49, 0.28) ${activeTo * 100}%, transparent ${activeTo * 100}%)`
                    : undefined,
                  boxShadow: active ? 'none' : undefined,
                }}
              >
                {block.text}
              </span>
            );
          })}
        </div>
      )}
      {annotations.length > 0 && (
        <div className="fixed-doc-annotation-layer" aria-hidden="true">
          {annotations.flatMap((annotation) =>
            ('quads' in annotation.anchor ? (annotation.anchor.quads ?? []) : []).map((quad, index) => {
              const rotated = rotateTextQuad(quad, rotation);
              return (
                <i
                  key={`${annotation.id}:${index}`}
                  className={`is-${annotation.type}${annotation.textAnchorRemap?.status === 'needs_review' ? ' is-remap-review' : ''}`}
                  style={{
                    left: `${rotated.x * 100}%`,
                    top: `${rotated.y * 100}%`,
                    width: `${rotated.width * 100}%`,
                    height: `${rotated.height * 100}%`,
                  }}
                />
              );
            }),
          )}
        </div>
      )}
      {regionSelectionEnabled && (
        <div
          className="fixed-doc-region-select-layer"
          aria-label="PDF 영역 선택"
          onPointerDown={startRegionSelection}
          onPointerMove={moveRegionSelection}
          onPointerUp={finishRegionSelection}
          onPointerCancel={() => setRegionDrag(undefined)}
        >
          {regionDrag && (
            <i
              style={{
                left: `${Math.min(regionDrag.startX, regionDrag.currentX) * 100}%`,
                top: `${Math.min(regionDrag.startY, regionDrag.currentY) * 100}%`,
                width: `${Math.abs(regionDrag.currentX - regionDrag.startX) * 100}%`,
                height: `${Math.abs(regionDrag.currentY - regionDrag.startY) * 100}%`,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
