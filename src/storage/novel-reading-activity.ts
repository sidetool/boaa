import type { Novel } from '../domain/types';
import type { ReadingPosition } from '../sync/types';
import { openReaderDb } from './reader-database';
import { requestToPromise } from './indexeddb-transaction';

/** Metadata updatedAt includes edits/imports; only actual reader records are activity evidence. */
function withReadingActivity(novel: Novel, position?: ReadingPosition): Novel {
  const savedAt = Date.parse(position?.updatedAt ?? '');
  const novelAt = Date.parse(novel.lastReadAt ?? '');
  return Number.isFinite(savedAt) && (!Number.isFinite(novelAt) || savedAt > novelAt)
    ? { ...novel, lastReadAt: position!.updatedAt }
    : novel;
}

/** One snapshot and two bulk reads, rather than one position lookup per library book. */
export async function novelsWithReadingActivity(): Promise<Novel[]> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'reading_positions'], 'readonly');
  const [novels, positions] = await Promise.all([
    requestToPromise<Novel[]>(tx.objectStore('novels').getAll()),
    requestToPromise<ReadingPosition[]>(tx.objectStore('reading_positions').getAll()),
  ]);
  const byNovel = new Map(positions.map((position) => [position.novelId, position]));
  return novels.map((novel) => withReadingActivity(novel, byNovel.get(novel.id)));
}

export async function novelWithReadingActivity(id: string): Promise<Novel | undefined> {
  const db = await openReaderDb();
  const tx = db.transaction(['novels', 'reading_positions'], 'readonly');
  const [novel, position] = await Promise.all([
    requestToPromise<Novel | undefined>(tx.objectStore('novels').get(id)),
    requestToPromise<ReadingPosition | undefined>(tx.objectStore('reading_positions').index('novelId').get(id)),
  ]);
  return novel && withReadingActivity(novel, position);
}
