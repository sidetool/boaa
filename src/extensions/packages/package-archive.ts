import { validateBoaaPackageManifest, type BoaaPackageManifestV1 } from '@boaa/extension-contracts/package';
import { verifyPackageArchive, type VerifiedPackageArchive } from './package-archive-core';
export { BoaaPackageError, INTEGRITY_DOMAIN, packageSha256, canonicalIntegrity } from './package-archive-core';
export type VerifiedBoaaPackage = VerifiedPackageArchive<BoaaPackageManifestV1>;
/** V1 remains source-only. UI packages must use their separate verifier. */
export function verifyBoaaExtension(archive: Blob, signal?: AbortSignal): Promise<VerifiedBoaaPackage> {
  return verifyPackageArchive(archive, { entry: 'dist/main.js', validate: validateBoaaPackageManifest }, signal);
}
