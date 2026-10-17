import type { hashSync } from '../hash';

type _LegacyHashCompatibilityBoundary = typeof hashSync;

export { chapterId, coverSeed, hash, normalizeSourceHash, novelId } from '@boaa/text-core/parser';
