import type { ComicReadingProfile } from '../domain/types';
import { DEFAULT_COMIC_READING_PROFILE } from '../features/fixed-document/comic-layout';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { openReaderDb } from './reader-database';
import { getByIndex, putItem, requestToPromise, transactionDone } from './indexeddb-transaction';

const GLOBAL_COMIC_PROFILE_BOOK_ID = '__moya_global_comic_profile__';

interface StoredComicReadingProfile extends ComicReadingProfile {
  readonly id: string;
  readonly bookId: string;
  readonly updatedAt: string;
  readonly automatic?: boolean;
}

function finiteRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function sanitizedPageCrops(value: ComicReadingProfile['pageCrops']): ComicReadingProfile['pageCrops'] {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 5_000)
      .map(([page, crop]) => [
        page,
        {
          top: finiteRange(crop.top, 0, 0, 0.3),
          right: finiteRange(crop.right, 0, 0, 0.3),
          bottom: finiteRange(crop.bottom, 0, 0, 0.3),
          left: finiteRange(crop.left, 0, 0, 0.3),
        },
      ]),
  );
}

export class IndexedDbComicReadingProfileRepository {
  /** Includes the global user preference: automatic defaults must never replace it. */
  async hasSaved(bookId: string): Promise<boolean> {
    const records = await Promise.all([
      getByIndex<StoredComicReadingProfile>(DOCUMENT_LISTENING_STORES.comicProfiles, 'bookId', bookId),
      getByIndex<StoredComicReadingProfile>(
        DOCUMENT_LISTENING_STORES.comicProfiles,
        'bookId',
        GLOBAL_COMIC_PROFILE_BOOK_ID,
      ),
    ]);
    return records.some(Boolean);
  }

  async get(
    bookId: string,
    fallback: Partial<ComicReadingProfile> = {},
    cropBookId = bookId,
  ): Promise<ComicReadingProfile> {
    const [globalProfile, bookProfile, cropProfile] = await Promise.all([
      getByIndex<StoredComicReadingProfile>(
        DOCUMENT_LISTENING_STORES.comicProfiles,
        'bookId',
        GLOBAL_COMIC_PROFILE_BOOK_ID,
      ),
      getByIndex<StoredComicReadingProfile>(DOCUMENT_LISTENING_STORES.comicProfiles, 'bookId', bookId),
      getByIndex<StoredComicReadingProfile>(DOCUMENT_LISTENING_STORES.comicProfiles, 'bookId', cropBookId),
    ]);
    const stored = globalProfile
      ? { ...globalProfile, pageCrops: cropProfile?.pageCrops }
      : bookProfile
        ? { ...bookProfile, pageCrops: cropProfile?.pageCrops }
        : undefined;
    if (!stored) return { ...DEFAULT_COMIC_READING_PROFILE, ...fallback };
    const profile: ComicReadingProfile = {
      ...DEFAULT_COMIC_READING_PROFILE,
      ...fallback,
      ...stored,
      brightness: finiteRange(stored.brightness, 1, 0.4, 1.8),
      contrast: finiteRange(stored.contrast, 1, 0.4, 2),
      saturation: finiteRange(stored.saturation, 1, 0, 2),
      gap: finiteRange(stored.gap, 8, 0, 48),
      manualCrop: {
        top: finiteRange(stored.manualCrop?.top, 0, 0, 0.3),
        right: finiteRange(stored.manualCrop?.right, 0, 0, 0.3),
        bottom: finiteRange(stored.manualCrop?.bottom, 0, 0, 0.3),
        left: finiteRange(stored.manualCrop?.left, 0, 0, 0.3),
      },
      pageCrops: sanitizedPageCrops(stored.pageCrops),
      pageTurnMotion:
        stored.pageTurnMotion === 'instant' || stored.pageTurnMotion === 'page' || stored.pageTurnMotion === 'slide'
          ? stored.pageTurnMotion
          : 'slide',
    };
    if (!globalProfile && bookProfile && !bookProfile.automatic) await this.save(bookId, profile, cropBookId);
    return profile;
  }

  /** Work-only automatic default; atomically yields to an existing user or automatic profile. */
  async saveAutomatic(bookId: string, profile: ComicReadingProfile): Promise<void> {
    const db = await openReaderDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.comicProfiles, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.comicProfiles);
    const [work, global] = await Promise.all([
      requestToPromise(store.index('bookId').get(bookId)),
      requestToPromise(store.index('bookId').get(GLOBAL_COMIC_PROFILE_BOOK_ID)),
    ]);
    if (!work && !global)
      store.put({
        ...profile,
        automatic: true,
        id: `comic_profile_${bookId}`,
        bookId,
        updatedAt: new Date().toISOString(),
      } satisfies StoredComicReadingProfile);
    await done;
  }

  async save(bookId: string, profile: ComicReadingProfile, cropBookId = bookId): Promise<void> {
    const updatedAt = new Date().toISOString();
    await Promise.all([
      putItem(DOCUMENT_LISTENING_STORES.comicProfiles, {
        ...profile,
        automatic: false,
        pageCrops: undefined,
        id: `comic_profile_${GLOBAL_COMIC_PROFILE_BOOK_ID}`,
        bookId: GLOBAL_COMIC_PROFILE_BOOK_ID,
        updatedAt,
      } satisfies StoredComicReadingProfile),
      putItem(DOCUMENT_LISTENING_STORES.comicProfiles, {
        ...profile,
        pageCrops: cropBookId === bookId ? profile.pageCrops : undefined,
        automatic: false,
        id: `comic_profile_${bookId}`,
        bookId,
        updatedAt,
      } satisfies StoredComicReadingProfile),
      ...(cropBookId === bookId
        ? []
        : [
            putItem(DOCUMENT_LISTENING_STORES.comicProfiles, {
              ...profile,
              automatic: true,
              id: `comic_profile_${cropBookId}`,
              bookId: cropBookId,
              updatedAt,
            } satisfies StoredComicReadingProfile),
          ]),
    ]);
  }
}
