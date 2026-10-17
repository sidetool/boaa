import { comicCropKey } from './comic-crop-key';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { ComicReadingProfile } from '../../domain/types';
import type { FixedDocumentScreenProps } from './FixedDocumentScreen';
import type { IndexedDbComicReadingProfileRepository } from '../../storage/comic-reading-profile-store';
import { loadSourceComicProfile } from './source-comic-default';

export interface SourceComicLayoutState {
  /** Gate visible image acquisition on this value; the resolved profile has already been applied. */
  readonly layoutReady: boolean;
  readonly error?: unknown;
  retry(): void;
}
/** Resolves and applies one profile per document/work identity before releasing image loading.
 * Returns layoutReady/error/retry. New identities synchronously return false; stale probes cannot
 * publish, and a user edit made during detection wins. No markup or loading presentation is prescribed.
 */
export function useSourceComicLayout(input: {
  document: Pick<FixedDocumentScreenProps, 'novel' | 'chapters' | 'repository' | 'assets'>;
  profiles: Pick<IndexedDbComicReadingProfileRepository, 'get' | 'hasSaved' | 'saveAutomatic'>;
  profileKey: string;
  detect: boolean;
  editVersion: { readonly current: number };
  begin(): void;
  apply(profile: ComicReadingProfile): void;
}): SourceComicLayoutState {
  const latest = useRef(input);
  latest.current = input;
  const enabled = input.document.novel.format === 'image_archive';
  const key = JSON.stringify([
    input.document.novel.id,
    input.document.novel.readingDirection,
    input.profileKey,
    comicCropKey(input.document.novel),
  ]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; attempt: number; ready: boolean; error?: unknown }>();
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const current = latest.current;
    const version = current.editVersion.current;
    const abort = new AbortController();
    current.begin();
    void loadSourceComicProfile(current.document, current.profiles, current.profileKey, current.detect, abort.signal)
      .then((profile) => {
        if (abort.signal.aborted) return;
        if (version === latest.current.editVersion.current) latest.current.apply(profile);
        setState({ key, attempt, ready: true });
      })
      .catch((error) => {
        if (!abort.signal.aborted) setState({ key, attempt, ready: false, error });
      });
    return () => abort.abort();
  }, [key, enabled, attempt]);
  const current = state?.key === key && state.attempt === attempt ? state : undefined;
  return { layoutReady: !enabled || Boolean(current?.ready), error: current?.error, retry };
}
