import { describe, expect, it } from 'vitest';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import {
  BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
  type BookEnrichmentApprovalReceipt,
  type BookEnrichmentProvenance,
} from './book-enrichment-contract';
import { approvalState, safeSourceUrl } from './book-enrichment-presentation';

const provenance: BookEnrichmentProvenance = {
  extensionId: 'trusted.catalog',
  extensionVersion: '1.2.0',
  contributionId: 'trusted.catalog.books',
  origin: 'bundled_trusted',
  registrationFingerprint: 'registration-hash',
  sourceFingerprints: ['catalog:book-1'],
  generatedAt: '2026-08-24T01:00:00.000Z',
  sourceLabel: '공식 작품 카탈로그',
  licenseSummary: '개인 서재 사용 허용',
};

function receipt(overrides: Partial<BookEnrichmentApprovalReceipt> = {}): BookEnrichmentApprovalReceipt {
  return {
    schemaVersion: BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
    id: 'receipt-1',
    action: 'apply',
    candidateId: 'candidate-1',
    bookId: 'book-1',
    kind: 'metadata',
    baseMetadataRevision: 6,
    appliedMetadataRevision: 7,
    selectedFields: ['title'],
    beforeHash: 'before-hash',
    afterHash: 'after-hash',
    before: { kind: 'metadata', values: { title: '이전 제목' } },
    after: { kind: 'metadata', values: { title: '추천 제목' } },
    provenance,
    appliedAt: '2026-08-24T02:03:00.000Z',
    ...overrides,
  };
}

describe('enrichment presentation', () => {
  it('offers undo only while the applied metadata still matches the book', () => {
    const approval = receipt();
    expect(approvalState(testNovel({ title: '추천 제목' }), approval, [approval])).toBe('available');
    expect(approvalState(testNovel({ title: 'changed' }), approval, [approval])).toBe('changed');
    expect(
      approvalState(testNovel({ title: '추천 제목' }), approval, [
        approval,
        receipt({ action: 'undo', approvalReceiptId: approval.id }),
      ]),
    ).toBe('undone');
    expect(approvalState(testNovel(), receipt({ before: undefined }), [])).toBe('record-only');
  });
  it('links only secure public source URLs without embedded credentials', () => {
    expect(safeSourceUrl('https://example.test/work')).toBe('https://example.test/work');
    for (const url of [undefined, '', 'invalid', 'http://example.test', 'https://user:pass@example.test'])
      expect(safeSourceUrl(url)).toBeUndefined();
  });
});
