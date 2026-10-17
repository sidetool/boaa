import type { ReaderRepository } from '../../repositories/reader-repository';
import type { BookWorkspaceReaderArtifacts } from './book-workspace-contract';

type ReaderArtifactRepository = Pick<ReaderRepository, 'listSegments' | 'listCharacters' | 'listVoiceProfiles'>;

const prepared = new WeakMap<
  object,
  Map<
    string,
    {
      chapterId: string;
      expires: number;
      value: Promise<BookWorkspaceReaderArtifacts>;
    }
  >
>();

/** Independent reads share the chapter-open wait; publication remains owned by navigation. */
export async function loadBookWorkspaceReaderArtifacts(
  repository: ReaderArtifactRepository,
  chapterId: string,
  novelId?: string,
  preparation?: { revision: string; consume?: boolean },
): Promise<BookWorkspaceReaderArtifacts> {
  let cache = prepared.get(repository);
  if (!cache) prepared.set(repository, (cache = new Map()));
  const key = preparation && JSON.stringify([novelId, chapterId, preparation.revision]);
  const hit = key && cache.get(key);
  if (hit && hit.expires > Date.now()) {
    if (preparation?.consume) cache.delete(key!);
    return hit.value;
  }
  const value = Promise.all([
    repository.listSegments(chapterId),
    novelId ? repository.listCharacters(novelId) : Promise.resolve([]),
    novelId ? repository.listVoiceProfiles(novelId) : Promise.resolve([]),
  ]).then(([segments, characters, voiceProfiles]) => {
    if (prepared.get(repository) !== cache) throw new DOMException('Reader session changed', 'AbortError');
    return { segments, characters, voiceProfiles };
  });
  if (key && !preparation?.consume) {
    const entry = { chapterId, expires: Date.now() + 120_000, value };
    cache.set(key, entry);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    void value.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  }
  return value;
}

/** Shares the body's chapter reset and authenticated repository invalidation boundary. */
export function invalidateBookWorkspaceReaderArtifacts(repository: object, chapterId?: string): void {
  if (chapterId === undefined) {
    prepared.delete(repository);
    return;
  }
  const cache = prepared.get(repository);
  if (!cache) return;
  for (const [key, entry] of cache) if (entry.chapterId === chapterId) cache.delete(key);
}
