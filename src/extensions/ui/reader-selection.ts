import type { Paragraph } from '../../domain/types';
import { validateUiResponse } from '@boaa/extension-contracts/ui-protocol';
import type { ReaderContext, SelectionCapture } from './runtime-commands';

/** Host-owned DOM anchors only. Never accept a locator supplied by guest JS. */
const textSelector = '[data-reader-text]';
const hiddenSelector = '[hidden], [inert], [aria-hidden="true"], .reader-paginated-page.is-outgoing';
function textRoot(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(textSelector) ?? null;
}
function splitsSurrogate(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}

/**
 * Synchronous click-time snapshot, independent of existing note/highlight/TTS selection handling.
 * Only original TXT/EPUB text fully mapped to one rendered paragraph fragment is shareable.
 * The caller must provide the current Reader generation and canonical revision's paragraph cache.
 */
export function captureReaderPluginSelection(input: {
  root: HTMLElement;
  selection: Selection | null;
  reader: ReaderContext;
  chapterId: string;
  format: string | undefined;
  mode: string;
  getParagraph: (id: string) => Paragraph | undefined;
}): SelectionCapture | undefined {
  const { root, selection, reader, chapterId, format, mode, getParagraph } = input;
  if (!root.isConnected || !['txt', 'epub'].includes(format ?? '') || !['read', 'listen'].includes(mode)) return;
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !reader.key) return;
  const range = selection.getRangeAt(0);
  const element = textRoot(range.startContainer);
  if (
    !element ||
    element !== textRoot(range.endContainer) ||
    !root.contains(element) ||
    element.closest(hiddenSelector)
  )
    return;
  if (element.dataset.readerBook !== reader.bookId || element.dataset.readerChapter !== chapterId) return;
  const paragraphId = element.dataset.readerText;
  if (!paragraphId) return;
  const paragraph = getParagraph(paragraphId);
  if (
    !paragraph ||
    paragraph.novelId !== reader.bookId ||
    paragraph.chapterId !== chapterId ||
    paragraph.id !== paragraphId
  )
    return;
  if (paragraph.documentKind === 'image' || paragraph.documentKind === 'separator') return;
  const rawOffset = element.dataset.readerSourceOffset;
  if (!rawOffset || !/^(0|[1-9][0-9]*)$/.test(rawOffset)) return;
  const sourceOffset = Number(rawOffset);
  const rendered = element.textContent ?? '';
  if (
    !Number.isSafeInteger(sourceOffset) ||
    sourceOffset + rendered.length > paragraph.text.length ||
    rendered !== paragraph.text.slice(sourceOffset, sourceOffset + rendered.length)
  )
    return;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = sourceOffset + prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  const end = sourceOffset + prefix.toString().length;
  const text = range.toString();
  if (
    start >= end ||
    end > sourceOffset + rendered.length ||
    !text.trim() ||
    splitsSurrogate(paragraph.text, start) ||
    splitsSurrogate(paragraph.text, end) ||
    text !== paragraph.text.slice(start, end)
  )
    return;
  const capture: SelectionCapture = {
    contextKey: reader.key,
    selection: {
      schemaVersion: 1,
      text,
      location: {
        schemaVersion: 1,
        bookId: reader.bookId,
        documentRevision: reader.documentRevision,
        // Opaque public locator. Offsets are UTF-16 offsets within the canonical paragraph.
        locator: JSON.stringify({ version: 1, type: 'text-range', chapterId, paragraphId, start, end }),
      },
      capturedAt: new Date().toISOString(),
      textSource: 'original',
    },
  };
  return validateUiResponse(
    { wireVersion: 1, kind: 'response', sessionId: 'host', requestId: 'capture', ok: true, result: capture.selection },
    'reader.consumeSelection',
  )
    ? capture
    : undefined;
}
