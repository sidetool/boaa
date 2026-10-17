import { vi } from 'vitest';
import type { DocumentTextBlock, DocumentTextRevision } from '../../domain/types';
import type { DocumentTextRepository } from '../../repositories/document-text-repository';
import type { DocumentAnnotationRepository } from '../../repositories/document-annotation-repository';
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const novel = { id: 'synthetic-book', rawTextHash: 'synthetic-hash', format: 'pdf' as const };
export function revision(pageIndex = 0): DocumentTextRevision {
  return {
    id: `revision-${pageIndex}`,
    bookId: novel.id,
    pageIndex,
    pageHash: `${novel.rawTextHash}:pdf-page:${pageIndex}`,
    source: 'pdf_native',
    engine: 'pdfjs',
    engineVersion: '1',
    status: 'ready',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}
export function block(pageIndex = 0): DocumentTextBlock {
  return {
    id: `block-${pageIndex}`,
    revisionId: revision(pageIndex).id,
    bookId: novel.id,
    pageIndex,
    order: 0,
    text: 'Synthetic document paragraph',
    normalizedText: 'Synthetic document paragraph',
    role: 'paragraph',
    direction: 'ltr',
    quads: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
  };
}
export function repository(): DocumentTextRepository {
  return {
    findReadyRevision: vi.fn(async () => undefined),
    listRevisions: vi.fn(async () => []),
    listReadyRevisions: vi.fn(async () => []),
    getBlocks: vi.fn(async () => []),
    getRawBlocks: vi.fn(async () => []),
    getOrderOverride: vi.fn(async () => undefined),
    saveOrderOverride: vi.fn(async () => {}),
    removeOrderOverride: vi.fn(async () => {}),
    saveRevision: vi.fn(async () => {}),
    markRevisionStatus: vi.fn(async () => {}),
    recoverInterruptedOcr: vi.fn(async () => []),
    saveReadyPage: vi.fn(async () => {}),
    search: vi.fn(async () => []),
  };
}
export function annotations() {
  return {
    listPage: vi.fn(async () => []),
    list: vi.fn(async () => []),
    save: vi.fn(async () => {}),
  } as unknown as DocumentAnnotationRepository;
}
