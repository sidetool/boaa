import { createAccountReaderDb } from '../../storage/reader-database';
import { stableId } from '../../domain/hash';
import { externalItemKeyId, type ExternalItemKey } from '../../external-sources/contracts';
import { IndexedDbReaderPersonalizationRepository } from '../../repositories/indexeddb-reader-personalization-repository';

export const localSessions = new IndexedDbReaderPersonalizationRepository();
const sessionsForScope = (scope?: string) =>
  scope?.startsWith('hosted-account:')
    ? new IndexedDbReaderPersonalizationRepository(createAccountReaderDb(scope))
    : localSessions;
export const pending = new Map<string, Promise<void>>();
export function sourceWorkSessionId(scope: string | undefined, work: ExternalItemKey): string {
  return stableId('source_sessions', JSON.stringify([scope ?? 'local', externalItemKeyId(work)]));
}
export async function sourceWorkReadingSeconds(id: string, scope?: string): Promise<number> {
  await pending.get(id);
  return (await sessionsForScope(scope).listReadingSessions({ bookId: id })).reduce(
    (sum, event) => sum + event.activeSeconds,
    0,
  );
}
export async function clearSourceWorkReadingTime(id: string, before?: string, scope?: string): Promise<void> {
  await pending.get(id);
  await sessionsForScope(scope).deleteReadingSessions({ bookId: id, before });
}
