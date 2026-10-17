import { comicCropKey } from './comic-crop-key';
import type { ComicReadingProfile } from '../../domain/types';
import type { FixedDocumentScreenProps } from './FixedDocumentScreen';
import type { IndexedDbComicReadingProfileRepository } from '../../storage/comic-reading-profile-store';
import { archiveImageDimensions } from './archive-image-dimensions';

export function isTallComicSample(sizes: readonly { width: number; height: number }[], expected: number): boolean {
  return (
    expected > 0 &&
    sizes.filter(
      ({ width, height }) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height / width > 2,
    ).length >
      expected / 2
  );
}

/** At most three sequential, cached asset reads; automatic defaults are persisted per work. A late user save wins over detection. */
export async function loadSourceComicProfile(
  input: Pick<FixedDocumentScreenProps, 'novel' | 'chapters' | 'repository' | 'assets'>,
  profiles: Pick<IndexedDbComicReadingProfileRepository, 'get' | 'hasSaved'> &
    Partial<Pick<IndexedDbComicReadingProfileRepository, 'saveAutomatic'>>,
  key: string,
  detect: boolean,
  signal: AbortSignal,
  measurePage = (blob: Blob) => archiveImageDimensions(blob, signal),
): Promise<ComicReadingProfile> {
  const fallback: Partial<ComicReadingProfile> = { direction: input.novel.readingDirection ?? 'ltr' };
  if (detect && !(await profiles.hasSaved(key))) {
    const sample = [...input.chapters].sort((a, b) => a.index - b.index).slice(0, 3);
    const sizes: { width: number; height: number }[] = [];
    for (const chapter of sample) {
      signal.throwIfAborted();
      try {
        const page = await input.repository.getParagraphPage(chapter.id, 0, signal);
        const assetId = page?.paragraphs.find((paragraph) => paragraph.assetId)?.assetId;
        const resource = assetId && (await input.assets.getEmbeddedResource(input.novel.id, assetId, signal));
        if (resource) sizes.push(await measurePage(resource.blob));
      } catch {
        signal.throwIfAborted();
      }
    }
    if (isTallComicSample(sizes, sample.length))
      Object.assign(fallback, { mode: 'vertical', seamlessVertical: true, fit: 'width' });
    signal.throwIfAborted();
    // Failed probes are retriable and must not persist a guessed layout.
    if (sizes.length === sample.length && sample.length)
      await profiles.saveAutomatic?.(key, await profiles.get(key, fallback));
  }
  signal.throwIfAborted();
  return profiles.get(key, fallback, comicCropKey(input.novel));
}
