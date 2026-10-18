import type { Novel } from '../domain/types';
import type { ExternalSourceLink } from './contracts';
import type { ExternalSourceLocalState, MissingBookHistoryContext } from './local-state';

export const EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS = 30 * 60_000;
const EXTERNAL_SOURCE_PENDING_CLOCK_SKEW_MS = 5 * 60_000;

export interface PendingExternalSourceLinkReconciliationOptions {
  /** Only complete, authoritative catalogs may prove permanent deletion. */
  readonly catalogIncludesTrash?: boolean;
  readonly history?: MissingBookHistoryContext;
  readonly resolveImporterApplied?: (
    staged: readonly ExternalSourceLink[],
    novel: Novel,
  ) => Promise<boolean | undefined>;
}

function normalizedHash(value: string | undefined): string | undefined {
  return (
    value
      ?.replace(/^sha256:/i, '')
      .trim()
      .toLocaleLowerCase() || undefined
  );
}

export async function saveExternalSourceLinks(
  state: ExternalSourceLocalState,
  links: readonly ExternalSourceLink[],
): Promise<void> {
  if (links.length === 0) return;
  if (state.saveLinks) {
    await state.saveLinks(links);
    return;
  }
  for (const link of links) await state.saveLink(link);
}

export async function acquireExternalSourcePendingLinks(
  state: ExternalSourceLocalState,
  links: readonly ExternalSourceLink[],
): Promise<void> {
  if (links.length === 0 || links.some((link) => !link.pendingImport)) {
    throw new Error('외부 소스 가져오기 작업이 올바르지 않습니다.');
  }
  if (state.acquirePendingLinks) {
    if (!(await state.acquirePendingLinks(links))) {
      throw new Error('다른 창에서 외부 소스 가져오기를 진행 중입니다.');
    }
    return;
  }
  await saveExternalSourceLinks(state, links);
}

export async function restoreExternalSourceLinks(
  state: ExternalSourceLocalState,
  staged: readonly ExternalSourceLink[],
  previous: readonly ExternalSourceLink[],
): Promise<boolean> {
  const previousById = new Map(previous.map((link) => [link.id, link]));
  const restore = staged.flatMap((link) => {
    const original = previousById.get(link.id);
    return original ? [original] : [];
  });
  const remove = staged.filter((link) => !previousById.has(link.id)).map((link) => link.id);
  const expected = staged.flatMap((link) =>
    link.pendingImport ? [{ id: link.id, operationId: link.pendingImport.operationId }] : [],
  );
  if (state.compareAndSwapPendingLinks && expected.length === staged.length) {
    return state.compareAndSwapPendingLinks(expected, restore, remove);
  }
  if (state.replaceLinks) {
    await state.replaceLinks(restore, remove);
    return true;
  }
  await saveExternalSourceLinks(state, restore);
  if (remove.length > 0 && state.deleteLinks) await state.deleteLinks(remove);
  return true;
}

export function finalizedExternalSourceLinks(
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): ExternalSourceLink[] {
  return staged.map((link) => {
    const pending = link.pendingImport;
    if (!pending) return link;
    return {
      ...link,
      localBookId: novel.id,
      collectionRemoteId: pending.collectionRemoteId ?? link.collectionRemoteId,
      importedRemoteRevision: pending.importedRemoteRevision,
      importedSourceContentHash: pending.importedSourceContentHash,
      activeContentRevisionId: novel.activeContentRevisionId,
      lastCheckedAt: new Date().toISOString(),
      pendingImport: undefined,
    };
  });
}

function acceptsImportedBook(link: ExternalSourceLink, novel: Novel): boolean {
  const pending = link.pendingImport;
  if (!pending || !novel.id) return false;
  if (pending.resolvedLocalBookId && pending.resolvedLocalBookId !== novel.id) return false;
  return link.localBookId === novel.id || (!pending.hadExistingLink && !pending.previousActiveContentRevisionId);
}

/** Keep a confirmed remap durable even if the final projection write is interrupted. */
export async function checkpointImportedExternalSourceLinks(
  state: ExternalSourceLocalState,
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): Promise<ExternalSourceLink[]> {
  if (staged.some((link) => !acceptsImportedBook(link, novel)))
    throw new Error('가져온 본문과 외부 소스 연결 식별자가 일치하지 않습니다.');
  if (staged.every((link) => link.localBookId === novel.id || link.pendingImport?.resolvedLocalBookId === novel.id))
    return [...staged];
  const checkpoint = staged.map((link) => ({
    ...link,
    pendingImport: { ...link.pendingImport!, resolvedLocalBookId: novel.id },
  }));
  if (state.compareAndSwapPendingLinks) {
    const applied = await state.compareAndSwapPendingLinks(
      staged.map((link) => ({ id: link.id, operationId: link.pendingImport!.operationId })),
      checkpoint,
      [],
    );
    if (!applied) throw new Error('다른 창에서 외부 소스 연결이 변경되었습니다.');
  } else await saveExternalSourceLinks(state, checkpoint);
  return checkpoint;
}

export async function finalizeExternalSourceLinks(
  state: ExternalSourceLocalState,
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): Promise<ExternalSourceLink[]> {
  if (
    staged.length === 0 ||
    staged.some(
      (link) =>
        !acceptsImportedBook(link, novel) ||
        !novel.sourceContentHash ||
        normalizedHash(link.pendingImport?.expectedActiveSourceContentHash) !== normalizedHash(novel.sourceContentHash),
    )
  ) {
    throw new Error('가져온 본문과 외부 소스 연결 식별자가 일치하지 않습니다.');
  }
  await checkpointImportedExternalSourceLinks(state, staged, novel);
  const next = finalizedExternalSourceLinks(staged, novel);
  const expected = staged.map((link) => ({
    id: link.id,
    operationId: link.pendingImport!.operationId,
  }));
  if (state.compareAndSwapPendingLinks) {
    const applied = await state.compareAndSwapPendingLinks(expected, next, []);
    if (!applied) throw new Error('다른 창에서 외부 소스 연결이 변경되었습니다.');
  } else {
    await saveExternalSourceLinks(state, next);
  }
  return next;
}

export async function finalizeImporterResolvedExternalSourceLinks(
  state: ExternalSourceLocalState,
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): Promise<ExternalSourceLink[]> {
  if (
    staged.length === 0 ||
    staged.some(
      (link) =>
        !link.pendingImport?.sourceHashResolvedByImporter ||
        !acceptsImportedBook(link, novel) ||
        !novel.activeContentRevisionId ||
        !novel.sourceContentHash,
    )
  ) {
    throw new Error('가져온 본문과 외부 소스 연결 식별자가 일치하지 않습니다.');
  }
  await checkpointImportedExternalSourceLinks(state, staged, novel);
  const next = finalizedExternalSourceLinks(staged, novel);
  const expected = staged.map((link) => ({
    id: link.id,
    operationId: link.pendingImport!.operationId,
  }));
  if (state.compareAndSwapPendingLinks) {
    const applied = await state.compareAndSwapPendingLinks(expected, next, []);
    if (!applied) throw new Error('다른 창에서 외부 소스 연결이 변경되었습니다.');
  } else {
    await saveExternalSourceLinks(state, next);
  }
  return next;
}

export async function reconcilePendingExternalSourceLinks(
  state: ExternalSourceLocalState,
  links: readonly ExternalSourceLink[],
  novels: readonly Novel[],
  now = Date.now(),
  options: PendingExternalSourceLinkReconciliationOptions = {},
): Promise<ExternalSourceLink[]> {
  const novelById = new Map(novels.map((novel) => [novel.id, novel]));
  const groups = new Map<string, ExternalSourceLink[]>();
  for (const link of links) {
    const operationId = link.pendingImport?.operationId;
    if (!operationId) continue;
    const group = groups.get(operationId) ?? [];
    group.push(link);
    groups.set(operationId, group);
  }
  const projected = new Map(links.map((link) => [link.id, link]));

  for (const staged of groups.values()) {
    const novel = novelById.get(staged[0]!.pendingImport?.resolvedLocalBookId ?? staged[0]!.localBookId);
    const importerResolvedSource = staged.every((link) => link.pendingImport?.sourceHashResolvedByImporter);
    if (importerResolvedSource && novel && !novel.deletedAt && options.resolveImporterApplied) {
      const importerApplied = await options.resolveImporterApplied(staged, novel).catch(() => undefined);
      if (importerApplied === true) {
        const finalized = await finalizeImporterResolvedExternalSourceLinks(state, staged, novel).catch(
          () => undefined,
        );
        if (finalized) {
          finalized.forEach((link) => projected.set(link.id, link));
          continue;
        }
      }
      if (importerApplied === undefined) continue;
    }
    const contentMatches = Boolean(
      !importerResolvedSource &&
      novel &&
      !novel.deletedAt &&
      novel.sourceContentHash &&
      staged.every(
        (link) =>
          normalizedHash(link.pendingImport?.expectedActiveSourceContentHash) ===
          normalizedHash(novel.sourceContentHash),
      ),
    );
    if (contentMatches) {
      const finalized = await finalizeExternalSourceLinks(state, staged, novel!).catch(() => undefined);
      finalized?.forEach((link) => projected.set(link.id, link));
      continue;
    }
    const intentIsFresh = staged.every((link) => {
      const stagedAt = Date.parse(link.pendingImport!.stagedAt);
      const age = now - stagedAt;
      return (
        Number.isFinite(stagedAt) &&
        age >= -EXTERNAL_SOURCE_PENDING_CLOCK_SKEW_MS &&
        age < EXTERNAL_SOURCE_PENDING_INTENT_LEASE_MS
      );
    });
    if (intentIsFresh) continue;
    // No response/receipt means an owner-scoped import may already be active.
    // Never infer a target from matching bytes or erase that unresolved intent.
    if (!novel && staged.some((link) => link.pendingImport?.bookIdMayChange && !link.pendingImport.hadExistingLink))
      continue;
    const previous = staged.flatMap((link) =>
      link.pendingImport?.hadExistingLink ? [{ ...link, pendingImport: undefined }] : [],
    );
    const restored = await restoreExternalSourceLinks(state, staged, previous).catch(() => false);
    if (restored) {
      const previousById = new Map(previous.map((link) => [link.id, link]));
      staged.forEach((link) => {
        const original = previousById.get(link.id);
        if (original) projected.set(link.id, original);
        else projected.delete(link.id);
      });
    }
  }
  const reconciled = [...projected.values()];
  if (options.catalogIncludesTrash && state.removeMissingBookLinks) {
    await state.removeMissingBookLinks(
      reconciled.filter((link) => !link.pendingImport && !novelById.has(link.localBookId)),
      options.history,
    );
    return state.listLinks();
  }
  return groups.size > 0 && typeof state.listLinks === 'function' ? state.listLinks() : reconciled;
}
