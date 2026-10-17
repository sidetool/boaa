import type { Novel } from '../../domain/types';
import {
  BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
  type BookEnrichmentApprovalReceipt,
  type BookEnrichmentMetadataField,
  type BookEnrichmentMutationSnapshot,
  type BookEnrichmentProvenance,
} from './book-enrichment-contract';
import type { BookEnrichmentController } from './useBookEnrichmentController';

export const fieldLabels: Record<BookEnrichmentMetadataField, string> = {
  title: '제목',
  author: '작가',
  seriesTitle: '시리즈',
  seriesIndex: '권',
  tags: '태그',
  description: '설명',
  language: '언어',
};

export function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '없음';
  if (value === null || value === undefined || value === '') return '없음';
  return String(value);
}

export function providerTitle(provenance: BookEnrichmentProvenance, controller: BookEnrichmentController): string {
  return (
    controller.providers.find((item) => item.descriptor.id === provenance.contributionId)?.descriptor.title ??
    provenance.sourceLabel ??
    '추천 제공자'
  );
}

export function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const matchTypeLabels: Record<string, string> = {
  exact_title_and_author: '제목·작가 정확히 일치',
  exact_title: '제목 정확히 일치',
  fuzzy_title: '유사 제목',
  ambiguous: '일치 결과 재검토 필요',
};

export type ApprovalState = 'available' | 'changed' | 'undone' | 'record-only';

function currentMetadataValue(book: Novel, field: BookEnrichmentMetadataField): unknown {
  return field === 'tags' ? [...(book.tags ?? [])] : (book[field] ?? null);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatchesBook(
  book: Novel,
  snapshot: BookEnrichmentMutationSnapshot,
  fields: readonly BookEnrichmentMetadataField[],
): boolean {
  if (snapshot.kind === 'metadata') {
    return fields.every((field) => sameValue(currentMetadataValue(book, field), snapshot.values[field] ?? null));
  }
  return (
    snapshot.cover.present === Boolean(book.coverAssetId && book.coverContentHash) &&
    (snapshot.cover.assetId ?? undefined) === book.coverAssetId &&
    (snapshot.cover.contentHash ?? undefined) === book.coverContentHash &&
    snapshot.cover.fit === (book.coverFit ?? 'crop') &&
    snapshot.cover.positionX === (book.coverPositionX ?? 50) &&
    snapshot.cover.positionY === (book.coverPositionY ?? 50)
  );
}

export function approvalState(
  book: Novel,
  approval: BookEnrichmentApprovalReceipt,
  receipts: readonly BookEnrichmentApprovalReceipt[],
): ApprovalState {
  if (receipts.some((receipt) => receipt.action === 'undo' && receipt.approvalReceiptId === approval.id)) {
    return 'undone';
  }
  if (
    approval.schemaVersion !== BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION ||
    approval.action !== 'apply' ||
    !approval.before ||
    !approval.after
  ) {
    return 'record-only';
  }
  return snapshotMatchesBook(book, approval.after, approval.selectedFields) ? 'available' : 'changed';
}

export const approvalStateLabels: Record<ApprovalState, string> = {
  available: '현재 상태 일치',
  changed: '이후 변경 있음',
  undone: '되돌림 완료',
  'record-only': '기록만 있음',
};
