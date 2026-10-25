import { integrityHash, tagLegacySha256Hash } from '@boaa/text-core/hash';
import type { Novel } from '../../domain/types';

export const MAX_IMPORT_DUPLICATE_HASH_BYTES = 32 * 1024 * 1024;

export type ImportDuplicatePolicy = 'open_existing' | 'skip' | 'copy' | 'replace' | 'new';

export interface ImportDuplicateConflict {
  readonly fileKey: string;
  readonly fileName: string;
  readonly kind: 'same_source' | 'same_name';
  readonly existingBook: Novel;
  readonly sourceHash?: string;
  readonly policy: ImportDuplicatePolicy;
}

export function importFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function inspectImportDuplicates(
  files: readonly File[],
  novels: readonly Novel[],
  sourceHashes?: Map<File, string>,
): Promise<ImportDuplicateConflict[]> {
  const conflicts: ImportDuplicateConflict[] = [];
  if (novels.length === 0) return conflicts;
  for (const file of files) {
    const sameName = novels.find(
      (novel) => novel.sourceFileName?.trim().toLocaleLowerCase() === file.name.trim().toLocaleLowerCase(),
    );
    const sourceHash =
      file.size <= MAX_IMPORT_DUPLICATE_HASH_BYTES ? integrityHash(await file.arrayBuffer()) : undefined;
    if (sourceHash) sourceHashes?.set(file, sourceHash);
    const sameSource = sourceHash
      ? novels.find((novel) => tagLegacySha256Hash(novel.rawTextHash.toLowerCase()) === sourceHash)
      : undefined;
    const existingBook = sameSource ?? sameName;
    if (!existingBook) continue;
    conflicts.push({
      fileKey: importFileKey(file),
      fileName: file.name,
      kind: sameSource ? 'same_source' : 'same_name',
      existingBook,
      sourceHash,
      policy: sameSource ? 'open_existing' : 'new',
    });
  }
  return conflicts;
}
