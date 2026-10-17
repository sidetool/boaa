import type { hashSync } from './hash';

type _LegacyHashCompatibilityBoundary = typeof hashSync;

export type { IntegrityHashVersion, PersistentIdVersion } from '@boaa/text-core/hash';
export {
  integrityHash,
  integrityHashVersion,
  isIntegrityHash,
  matchesIntegrityHash,
  persistentId128,
  persistentIdVersion,
  tagLegacySha256Hash,
} from '@boaa/text-core/hash';
