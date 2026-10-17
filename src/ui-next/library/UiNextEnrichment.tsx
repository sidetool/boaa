import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { Check, ExternalLink, History, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Novel } from '../../domain/types';
import {
  approvalState,
  approvalStateLabels,
  displayValue,
  fieldLabels,
  matchTypeLabels,
  providerTitle,
  safeSourceUrl,
} from '../../features/book-enrichment/book-enrichment-presentation';
import {
  BOOK_ENRICHMENT_METADATA_FIELDS,
  type BookEnrichmentCandidate,
  type BookEnrichmentMetadataField,
  type BookEnrichmentProvenance,
} from '../../features/book-enrichment/book-enrichment-contract';
import type { BookEnrichmentController } from '../../features/book-enrichment/useBookEnrichmentController';
import { formatDateTime } from '../../utils/format';
import { cx } from '../components/primitives';

interface EnrichmentProps {
  book: Novel;
  controller: BookEnrichmentController;
  /** Unsaved manual edits block applying, because a suggestion writes straight to the work. */
  dirty: boolean;
  saveDraft(): Promise<void>;
  onApplied(): void;
  cover: React.ReactNode;
}

function Source({
  provenance,
  controller,
}: {
  provenance: BookEnrichmentProvenance;
  controller: BookEnrichmentController;
}) {
  const url = safeSourceUrl(provenance.sourceUrl);
  const match = provenance.automation?.matchType;
  return (
    <p className="un-auto-source">
      <b>{providerTitle(provenance, controller)}</b>
      {match && <span>{matchTypeLabels[match] ?? match}</span>}
      {provenance.confidence !== undefined && <span>일치 {Math.round(provenance.confidence * 100)}%</span>}
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          원본 <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </p>
  );
}

function MetadataSuggestion({
  candidate,
  controller,
  blocked,
  onApplied,
}: {
  candidate: Extract<BookEnrichmentCandidate, { kind: 'metadata' }>;
  controller: BookEnrichmentController;
  blocked: boolean;
  onApplied(): void;
}) {
  const fields = BOOK_ENRICHMENT_METADATA_FIELDS.filter((field) => candidate.patch[field] !== undefined);
  const [selected, setSelected] = useState<Set<BookEnrichmentMetadataField>>(() => new Set(fields));
  const stale = candidate.status === 'stale';
  const toggle = (field: BookEnrichmentMetadataField) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });

  return (
    <article className={cx('un-auto-card', stale && 'is-stale')} data-testid="metadata-enrichment-candidate">
      <Source provenance={candidate.provenance} controller={controller} />
      {stale && <p className="un-auto-warn">작품 정보가 바뀌어서 다시 찾아야 해요.</p>}
      <ul className="un-auto-fields">
        {fields.map((field) => {
          const on = selected.has(field);
          const current = displayValue(candidate.baseValues[field]);
          return (
            <li key={field}>
              <label className={cx(on && 'is-on')}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={stale || controller.busy}
                  onChange={() => toggle(field)}
                />
                <span className="un-auto-check" aria-hidden="true">
                  <Check size={14} />
                </span>
                <span className="un-auto-field">
                  <small>{fieldLabels[field]}</small>
                  <b className={field === 'description' ? 'is-long' : undefined}>
                    {displayValue(candidate.patch[field])}
                  </b>
                  {current !== '없음' && <s>지금: {current}</s>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="un-auto-actions">
        <button
          type="button"
          className="un-btn is-text is-sm"
          disabled={controller.busy}
          onClick={() => void controller.reject(candidate.id)}
        >
          건너뛰기
        </button>
        <button
          type="button"
          className="un-btn is-primary is-sm"
          disabled={stale || blocked || controller.busy || selected.size === 0}
          onClick={() =>
            void controller.applyMetadata(candidate.id, [...selected]).then((applied) => applied && onApplied())
          }
        >
          {selected.size === fields.length ? '모두 적용' : `${selected.size}개 적용`}
        </button>
      </div>
    </article>
  );
}

function CoverSuggestion({
  candidate,
  controller,
  blocked,
  onApplied,
  current,
}: {
  candidate: Extract<BookEnrichmentCandidate, { kind: 'cover' }>;
  controller: BookEnrichmentController;
  blocked: boolean;
  onApplied(): void;
  current: React.ReactNode;
}) {
  const previewUrl = useMemo(() => URL.createObjectURL(candidate.cover.blob), [candidate.cover.blob]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  const stale = candidate.status === 'stale';
  const { fit, positionX, positionY } = candidate.cover;

  return (
    <article className={cx('un-auto-card', stale && 'is-stale')} data-testid="cover-enrichment-candidate">
      <Source provenance={candidate.provenance} controller={controller} />
      {stale && <p className="un-auto-warn">작품 정보가 바뀌어서 다시 찾아야 해요.</p>}
      <div className="un-auto-covers">
        <figure>
          {current}
          <figcaption>지금 표지</figcaption>
        </figure>
        <span className="un-auto-arrow" aria-hidden="true">
          →
        </span>
        <figure className="is-new">
          <div className="un-cover">
            <img
              src={previewUrl}
              alt="추천 표지"
              style={{ objectFit: fit === 'crop' ? 'cover' : 'contain', objectPosition: `${positionX}% ${positionY}%` }}
            />
          </div>
          <figcaption>추천 표지</figcaption>
        </figure>
      </div>
      <div className="un-auto-actions">
        <button
          type="button"
          className="un-btn is-text is-sm"
          disabled={controller.busy}
          onClick={() => void controller.reject(candidate.id)}
        >
          건너뛰기
        </button>
        <button
          type="button"
          className="un-btn is-primary is-sm"
          disabled={stale || blocked || controller.busy}
          onClick={() =>
            void controller
              .applyCover(candidate.id, { fit, positionX, positionY })
              .then((applied) => applied && onApplied())
          }
        >
          표지 적용
        </button>
      </div>
    </article>
  );
}

/** 자동으로 채우기: find the work online, review each suggested field, apply in one tap, undo later. */
export function UiNextEnrichment({ book, controller, dirty, saveDraft, onApplied, cover }: EnrichmentProps) {
  const [providerId, setProviderId] = useState<ExtensionContributionId | ''>(
    controller.providers[0]?.descriptor.id ?? '',
  );
  const [searched, setSearched] = useState(false);
  const load = controller.load;
  useEffect(() => void load(book.id), [book.id, load]);
  useEffect(() => {
    if (!controller.providers.some((provider) => provider.descriptor.id === providerId))
      setProviderId(controller.providers[0]?.descriptor.id ?? '');
  }, [controller.providers, providerId]);

  if (!controller.available) return null;
  const activeIds = new Set(controller.providers.map((provider) => provider.descriptor.id));
  const pending = controller.candidates.filter(
    (candidate) =>
      candidate.bookId === book.id &&
      (candidate.status === 'pending' || candidate.status === 'stale') &&
      activeIds.has(candidate.provenance.contributionId),
  );
  const approvals = controller.receipts
    .filter((receipt) => receipt.bookId === book.id && receipt.action !== 'undo')
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  const hasProviders = controller.providers.length > 0;

  return (
    <section className="un-auto" aria-labelledby="un-auto-title">
      <div className="un-auto-head">
        <span className="un-auto-icon" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <div>
          <h3 id="un-auto-title">자동으로 채우기</h3>
          <p>
            {hasProviders
              ? '제목으로 작품을 찾아 표지·작가·소개·태그를 가져와요.'
              : '설정 › 기능 확장에서 작품 정보 확장을 켜면 표지와 소개를 자동으로 가져올 수 있어요.'}
          </p>
        </div>
      </div>

      {hasProviders && (
        <div className="un-auto-run">
          {controller.providers.length > 1 && (
            <select
              aria-label="작품 정보를 찾을 곳"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value as ExtensionContributionId)}
            >
              {controller.providers.map((provider) => (
                <option key={provider.descriptor.id} value={provider.descriptor.id}>
                  {provider.descriptor.title}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="un-btn is-primary"
            disabled={controller.busy || !providerId}
            onClick={() => {
              setSearched(true);
              if (providerId) void controller.propose(book.id, providerId);
            }}
          >
            <RefreshCw size={16} className={controller.busy ? 'spin' : undefined} aria-hidden="true" />
            {controller.busy ? '찾는 중…' : pending.length ? '다시 찾기' : '작품 정보 찾기'}
          </button>
        </div>
      )}

      {controller.error && <p className="un-auto-warn">{controller.error}</p>}
      {dirty && pending.length > 0 && (
        <div className="un-auto-blocked">
          <span>직접 고친 내용이 있어요. 먼저 저장해야 추천을 적용할 수 있어요.</span>
          <button type="button" className="un-btn is-ghost is-sm" onClick={() => void saveDraft()}>
            지금 저장
          </button>
        </div>
      )}

      {pending.map((candidate) =>
        candidate.kind === 'metadata' ? (
          <MetadataSuggestion
            key={candidate.id}
            candidate={candidate}
            controller={controller}
            blocked={dirty}
            onApplied={onApplied}
          />
        ) : (
          <CoverSuggestion
            key={candidate.id}
            candidate={candidate}
            controller={controller}
            blocked={dirty}
            onApplied={onApplied}
            current={cover}
          />
        ),
      )}
      {searched && !controller.busy && pending.length === 0 && !controller.error && (
        <p className="un-auto-empty">새로 찾은 정보가 없어요.</p>
      )}

      {approvals.length > 0 && (
        <details className="un-auto-history">
          <summary>
            <History size={15} aria-hidden="true" />
            적용 기록 {approvals.length}개
          </summary>
          <ul>
            {approvals.map((receipt) => {
              const state = approvalState(book, receipt, controller.receipts);
              const canUndo = state === 'available' && !dirty && !controller.busy;
              return (
                <li key={receipt.id}>
                  <span>
                    <b>
                      {receipt.selectedFields.length
                        ? receipt.selectedFields.map((field) => fieldLabels[field]).join(', ')
                        : '표지'}
                    </b>
                    <small>
                      {providerTitle(receipt.provenance, controller)} · {formatDateTime(receipt.appliedAt)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="un-btn is-text is-sm"
                    disabled={!canUndo}
                    onClick={() => void controller.undo(receipt.id).then((undone) => undone && onApplied())}
                  >
                    {state === 'available' ? (
                      <>
                        <RotateCcw size={14} aria-hidden="true" /> 되돌리기
                      </>
                    ) : (
                      approvalStateLabels[state]
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
