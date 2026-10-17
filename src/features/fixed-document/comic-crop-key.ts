import type { Novel } from '../../domain/types';
/** Automatic crops belong to a document revision, never to its shared work display profile. */
export function comicCropKey(novel: Pick<Novel, 'id' | 'activeContentRevisionId'>): string {
  return novel.activeContentRevisionId ? `${novel.id}:crops:${novel.activeContentRevisionId}` : novel.id;
}
