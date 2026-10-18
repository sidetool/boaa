import type { BookEnrichmentRepository } from './book-enrichment-repository';
import { createBookEnrichmentStore } from '../storage/book-enrichment-store';
import { openReaderDb } from '../storage/reader-database';

export class IndexedDbBookEnrichmentRepository implements BookEnrichmentRepository {
  private readonly store;
  constructor(openDatabase: () => Promise<IDBDatabase> = openReaderDb) {
    this.store = createBookEnrichmentStore(openDatabase);
  }
  listCandidates(bookId: string) {
    return this.store.listBookEnrichmentCandidates(bookId);
  }

  listReceipts(bookId: string) {
    return this.store.listBookEnrichmentReceipts(bookId);
  }

  getReceipt(receiptId: string) {
    return this.store.getBookEnrichmentReceipt(receiptId);
  }

  getCandidate(candidateId: string) {
    return this.store.getBookEnrichmentCandidate(candidateId);
  }

  replacePendingCandidates(...args: Parameters<BookEnrichmentRepository['replacePendingCandidates']>) {
    return this.store.replacePendingBookEnrichmentCandidates(...args);
  }

  updateCandidateStatus(...args: Parameters<BookEnrichmentRepository['updateCandidateStatus']>) {
    return this.store.updateBookEnrichmentCandidateStatus(...args);
  }

  stageApprovalIntent(...args: Parameters<BookEnrichmentRepository['stageApprovalIntent']>) {
    return this.store.stageBookEnrichmentApprovalIntent(...args);
  }

  resolveApprovalIntent(...args: Parameters<BookEnrichmentRepository['resolveApprovalIntent']>) {
    return this.store.resolveBookEnrichmentApprovalIntent(...args);
  }

  recordApproval(...args: Parameters<BookEnrichmentRepository['recordApproval']>) {
    return this.store.recordBookEnrichmentApproval(...args);
  }

  recordUndo(...args: Parameters<BookEnrichmentRepository['recordUndo']>) {
    return this.store.recordBookEnrichmentUndo(...args);
  }

  reconcileCandidatesAfterApproval(...args: Parameters<BookEnrichmentRepository['reconcileCandidatesAfterApproval']>) {
    return this.store.reconcileBookEnrichmentCandidatesAfterApproval(...args);
  }
}
