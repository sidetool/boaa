import { readBrandStorage } from '@boaa/extension-contracts/brand-compat';
import { externalItemKeyId, type ExternalItemKey } from './contracts';
import type { ExternalSourceLocalState } from './local-state';
import {
  validLastReadRelease,
  validLastReadWork,
  releasePreferenceId,
  type SourceReleasePreference,
} from './source-user-state';

const storageKey = 'boaa.source-stream-pending-visits.v1';
type PendingVisit = { scope: string; preference: SourceReleasePreference };
function scopedKey(scope?: string) {
  return scope?.startsWith('hosted-account:') ? `${storageKey}:${scope}` : storageKey;
}
function entries(scope?: string): PendingVisit[] {
  try {
    const value: unknown = JSON.parse(
      (scopedKey(scope) === storageKey
        ? readBrandStorage(localStorage, storageKey)
        : localStorage.getItem(scopedKey(scope))) ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is PendingVisit => {
        const p = entry?.preference;
        return (
          typeof entry?.scope === 'string' &&
          p?.kind === 'releasePreference' &&
          p.read === true &&
          p.readingMode === 'stream' &&
          (p.lastReadRelease === undefined || validLastReadRelease(p.lastReadRelease)) &&
          (p.lastReadWork === undefined || validLastReadWork(p.lastReadWork)) &&
          typeof p.source?.connectorId === 'string' &&
          typeof p.source.remoteId === 'string' &&
          (p.source.accountConnectionId === undefined || typeof p.source.accountConnectionId === 'string') &&
          typeof p.collectionRemoteId === 'string' &&
          typeof p.lastReadAt === 'string' &&
          Number.isFinite(Date.parse(p.lastReadAt)) &&
          p.readChangedAt === p.lastReadAt &&
          p.updatedAt === p.lastReadAt &&
          p.id === releasePreferenceId(p.source)
        );
      })
      .slice(-200);
  } catch {
    return [];
  }
}
function write(value: PendingVisit[], scope?: string) {
  try {
    localStorage.setItem(scopedKey(scope), JSON.stringify(value.slice(-200)));
  } catch {
    /* The normal repository still handles saves when browser storage is unavailable. */
  }
}

/** Checkpoint the visited episode synchronously, before any IndexedDB/network queue can yield. */
export function stageSourceStreamVisit(
  scope: string | undefined,
  source: ExternalItemKey,
  collectionRemoteId: string,
  readAt: string,
  lastReadRelease?: SourceReleasePreference['lastReadRelease'],
  lastReadWork?: SourceReleasePreference['lastReadWork'],
): void {
  const id = releasePreferenceId(source);
  const preference: SourceReleasePreference = {
    id,
    kind: 'releasePreference',
    source,
    collectionRemoteId,
    readingMode: 'stream',
    read: true,
    readChangedAt: readAt,
    lastReadAt: readAt,
    ...(lastReadRelease ? { lastReadRelease } : {}),
    ...(lastReadWork ? { lastReadWork } : {}),
    updatedAt: readAt,
  };
  write(
    [
      ...entries(scope).filter((entry) => entry.scope !== (scope ?? 'local') || entry.preference.id !== id),
      { scope: scope ?? 'local', preference },
    ],
    scope,
  );
}

export function acknowledgeSourceStreamVisit(scope: string | undefined, source: ExternalItemKey, readAt: string): void {
  write(
    entries(scope).filter(
      (entry) =>
        entry.scope !== (scope ?? 'local') ||
        externalItemKeyId(entry.preference.source) !== externalItemKeyId(source) ||
        entry.preference.lastReadAt !== readAt,
    ),
    scope,
  );
}

/** Recover interrupted writes on reload; newer manual unread choices and later visits remain authoritative. */
export async function recoverSourceStreamVisits(
  scope: string | undefined,
  state: Pick<
    ExternalSourceLocalState,
    'listReleasePreferences' | 'saveReleasePreferences' | 'replaySourceStreamVisit'
  >,
): Promise<SourceReleasePreference[]> {
  const preferences = new Map(((await state.listReleasePreferences?.()) ?? []).map((p) => [p.id, p]));
  for (const { preference: pending } of entries(scope).filter((entry) => entry.scope === (scope ?? 'local'))) {
    const current = preferences.get(pending.id);
    const superseded =
      current &&
      ((current.readChangedAt ?? '') >= pending.lastReadAt! || (current.lastReadAt ?? '') >= pending.lastReadAt!);
    const next = superseded ? current : { ...current, ...pending };
    preferences.set(next.id, next);
    try {
      if (state.replaySourceStreamVisit) {
        // The snapshot may predate a concurrent purge/reset. Use the result of the
        // repository's atomic comparison for both persistence and projection.
        preferences.set(pending.id, await state.replaySourceStreamVisit(pending));
      } else if (!superseded) {
        if (!state.saveReleasePreferences) continue;
        await state.saveReleasePreferences([next]);
      }
      acknowledgeSourceStreamVisit(scope, pending.source, pending.lastReadAt!);
    } catch (error) {
      // An atomic comparison failure cannot establish whether a concurrent reset
      // superseded the checkpoint. Keep it for retry without publishing stale history.
      if (state.replaySourceStreamVisit) throw error;
      /* Legacy ports retain the device checkpoint until the repository becomes writable. */
    }
  }
  return [...preferences.values()];
}

/** Snapshot interrupted visits for atomic last-association history retirement. */
export function pendingSourceStreamPreferences(scope: string | undefined): SourceReleasePreference[] {
  return entries(scope)
    .filter((entry) => entry.scope === (scope ?? 'local'))
    .map((entry) => entry.preference);
}
