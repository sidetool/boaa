import type { DocumentAnnotation, DocumentTextBlock, DocumentTextRevision, Novel } from '../../../domain/types';
import type { DocumentTextRepository } from '../../../repositories/document-text-repository';
import type { DocumentAnnotationRepository } from '../../../repositories/document-annotation-repository';
import { remapFixedTextAnnotation } from './fixed-text-annotation-remap';

export type PdfTextIdentity = Pick<Novel, 'id' | 'rawTextHash' | 'activeContentRevisionId' | 'format'>;
export const pdfPageHash = (novel: Pick<Novel, 'rawTextHash'>, pageIndex: number) =>
  `${novel.rawTextHash}:pdf-page:${pageIndex}`;
export const pdfTextScope = (novel: PdfTextIdentity) =>
  JSON.stringify([novel.id, novel.rawTextHash, novel.activeContentRevisionId, novel.format]);

export async function remapPdfTextAnnotations(
  repository: DocumentAnnotationRepository,
  revision: DocumentTextRevision,
  blocks: readonly DocumentTextBlock[],
): Promise<DocumentAnnotation[] | undefined> {
  const annotations = await repository.listPage(revision.bookId, revision.pageIndex);
  const changed = annotations
    .map((annotation) => remapFixedTextAnnotation({ annotation, targetRevision: revision, targetBlocks: blocks }))
    .filter((result) => result.changed);
  if (!changed.length) return;
  await Promise.all(changed.map((result) => repository.save(result.annotation)));
  return repository.list(revision.bookId);
}

/** Once ready content commits, finish its remap/pending cleanup against the captured repositories before exposing it. */
export async function publishPdfTextRevision(input: {
  repository: DocumentTextRepository;
  annotations: DocumentAnnotationRepository;
  revision: DocumentTextRevision;
  blocks: readonly DocumentTextBlock[];
  pendingRevisionId?: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  await input.repository.saveReadyPage(input.revision, input.blocks);
  const annotations = await remapPdfTextAnnotations(input.annotations, input.revision, input.blocks).catch(
    () => undefined,
  );
  if (input.pendingRevisionId)
    await input.repository.markRevisionStatus(input.pendingRevisionId, 'stale').catch(() => undefined);
  const blocks = await input.repository.getBlocks(input.revision.id);
  const readyCount = (await input.repository.listReadyRevisions(input.revision.bookId)).length;
  return { blocks, annotations, readyCount };
}
