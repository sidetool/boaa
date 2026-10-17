import { migrateBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { readBrandStorage, removeBrandStorage, writeBrandStorage } from '@boaa/extension-contracts/brand-compat';
const WORKFLOW_PREFIX = 'boaa.book_ai_workflow.';
const UPLOAD_SESSION_PREFIX = 'boaa.remoteUploadSession.';

export interface BookScopedLocalStorageMigrationResult {
  workflowMoved: boolean;
  uploadSessionsMoved: number;
}

export function migrateBookScopedLocalStorageKeys(
  oldNovelId: string,
  newNovelId: string,
  storage: Storage | undefined = globalThis.localStorage,
): BookScopedLocalStorageMigrationResult {
  if (!storage || oldNovelId === newNovelId) return { workflowMoved: false, uploadSessionsMoved: 0 };
  migrateBrandStorage(storage);
  let workflowMoved = false;
  let uploadSessionsMoved = 0;
  try {
    const oldWorkflowKey = `${WORKFLOW_PREFIX}${oldNovelId}`;
    const newWorkflowKey = `${WORKFLOW_PREFIX}${newNovelId}`;
    const workflowId = readBrandStorage(storage, oldWorkflowKey);
    if (workflowId !== null) {
      if (readBrandStorage(storage, newWorkflowKey) === null) writeBrandStorage(storage, newWorkflowKey, workflowId);
      removeBrandStorage(storage, oldWorkflowKey);
      workflowMoved = true;
    }

    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string =>
      Boolean(key?.startsWith(UPLOAD_SESSION_PREFIX)),
    );
    const encodedOldId = encodeURIComponent(oldNovelId);
    const encodedNewId = encodeURIComponent(newNovelId);
    keys.forEach((key) => {
      const raw = readBrandStorage(storage, key);
      if (!raw) return;
      try {
        const session = JSON.parse(raw) as Record<string, unknown>;
        if (session.clientBookId !== oldNovelId) return;
        session.clientBookId = newNovelId;
        const suffix = key.slice(UPLOAD_SESSION_PREFIX.length);
        const nextSuffix = suffix.includes(encodedOldId) ? suffix.replace(encodedOldId, encodedNewId) : suffix;
        const nextKey = `${UPLOAD_SESSION_PREFIX}${nextSuffix}`;
        writeBrandStorage(storage, nextKey, JSON.stringify(session));
        if (nextKey !== key) removeBrandStorage(storage, key);
        uploadSessionsMoved += 1;
      } catch {
        // A malformed resume row is left untouched and will expire through the existing cleanup path.
      }
    });
  } catch {
    // localStorage can be unavailable in privacy-restricted browser contexts.
  }
  return { workflowMoved, uploadSessionsMoved };
}

export function readBookScopedLocalStorageValue(
  prefix: string,
  canonicalNovelId: string,
  legacyNovelId: string | undefined,
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  if (!storage) return null;
  try {
    return (
      readBrandStorage(storage, `${prefix}${canonicalNovelId}`) ??
      (legacyNovelId ? readBrandStorage(storage, `${prefix}${legacyNovelId}`) : null)
    );
  } catch {
    return null;
  }
}
