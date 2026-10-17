import { validateBrowserUiManifest, type BrowserUiManifest } from '@boaa/extension-contracts/ui-package';
import { isBoaaPackagePath, BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { BoaaPackageError, verifyPackageArchive, type VerifiedPackageArchive } from './package-archive-core';
import { writePackageArchive, type PackageBuildInput } from './package-archive-writer';
export type VerifiedBrowserUiPackage = VerifiedPackageArchive<BrowserUiManifest>;
/** Offline inspection only. Does not load, evaluate, install, or approve plugin code. */
export function verifyBrowserUiPackage(archive: Blob, signal?: AbortSignal): Promise<VerifiedBrowserUiPackage> {
  return verifyPackageArchive(archive, { entry: 'dist/ui.js', validate: validateBrowserUiManifest }, signal);
}
export async function buildBrowserUiPackage(input: PackageBuildInput): Promise<Blob> {
  const validation = validateBrowserUiManifest(input.manifest);
  if (!validation.ok) throw new BoaaPackageError(validation.code);
  const encode = (s: string) => new TextEncoder().encode(s).length;
  const sourceSize = encode(input.source);
  if (sourceSize > BOAA_PACKAGE_LIMITS.entryBytes) throw new BoaaPackageError('package_limit');
  let size =
    sourceSize + encode(input.license) + encode(input.notices ?? '') + encode(JSON.stringify(validation.manifest));
  // Reserve two entries for generated integrity and publisher metadata.
  if ((input.assets?.size ?? 0) + 6 > BOAA_PACKAGE_LIMITS.entries) throw new BoaaPackageError('package_limit');
  for (const [name, bytes] of input.assets ?? []) {
    if (!isBoaaPackagePath(`assets/${name}`) || !/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(name))
      throw new BoaaPackageError('invalid_package_entry');
    size += bytes.length;
  }
  if (size > BOAA_PACKAGE_LIMITS.expandedBytes) throw new BoaaPackageError('package_limit');
  const archive = await writePackageArchive(input, 'dist/ui.js');
  await verifyBrowserUiPackage(archive);
  return archive;
}
