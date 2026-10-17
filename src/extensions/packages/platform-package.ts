import {
  validatePlatformManifest,
  type EntryRole,
  type PlatformManifest,
} from '@boaa/extension-contracts/platform-package';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import {
  BoaaPackageError,
  packageSha256,
  verifyPackageArchive,
  type VerifiedPackageArchive,
} from './package-archive-core';
import { writePackageArchive, type PackageBuildInput } from './package-archive-writer';
import { inspectSingleJs, SOURCE_LIMIT } from './platform-single-js';
import { parsePlatformMetadata } from './platform-metadata';

const roles = ['controller', 'ui', 'task'] as const;
export type VerifiedPlatformPackage = Omit<VerifiedPackageArchive<PlatformManifest>, 'source'> & {
  readonly sources: Readonly<Record<string, string>>;
};
export interface PlatformPackageBuildInput extends Omit<PackageBuildInput, 'source'> {
  sources: Partial<Record<EntryRole, string>>;
}
/** Static review only: never evaluates an entry, invokes registration, or grants execution. */
export async function verifyPlatformPackage(archive: Blob, signal?: AbortSignal): Promise<VerifiedPlatformPackage> {
  const result = await verifyPackageArchive(
    archive,
    {
      entry: roles.map((role) => `dist/${role}.js`),
      declaredEntries: (manifest) =>
        roles.flatMap((role) => (manifest.entries[role] ? [manifest.entries[role]!.path] : [])),
      parseManifest: parsePlatformMetadata,
      validate: validatePlatformManifest,
    },
    signal,
  );
  // There is deliberately no implicit "main" source for multi-role packages.
  return {
    digest: result.digest,
    manifest: result.manifest,
    sources: result.sources,
    archive: result.archive,
    publisherFingerprint: result.publisherFingerprint,
  };
}
export async function buildPlatformPackage(input: PlatformPackageBuildInput): Promise<Blob> {
  const validation = validatePlatformManifest(input.manifest);
  if (!validation.ok) throw new BoaaPackageError(validation.code);
  const manifest = structuredClone(validation.manifest);
  const entries = new Map<string, string>();
  if (Object.keys(input.sources).some((role) => !roles.includes(role as EntryRole)))
    throw new BoaaPackageError('undeclared_package_entry');
  const size = (value: string) => new TextEncoder().encode(value).length;
  let expanded = size(JSON.stringify(manifest)) + size(input.license) + size(input.notices ?? '');
  for (const role of roles) {
    const declared = manifest.entries[role];
    const source = input.sources[role];
    if (!declared && source !== undefined) throw new BoaaPackageError('undeclared_package_entry');
    if (!declared) continue;
    if (typeof source !== 'string') throw new BoaaPackageError('incomplete_package');
    if (size(source) > BOAA_PACKAGE_LIMITS.entryBytes) throw new BoaaPackageError('package_limit');
    expanded += size(source);
    entries.set(declared.path, source);
  }
  if (entries.size + (input.assets?.size ?? 0) + 5 > BOAA_PACKAGE_LIMITS.entries)
    throw new BoaaPackageError('package_limit');
  // Snapshot authoring input before asynchronous hashing/signing.
  const assets = new Map<string, Uint8Array>();
  for (const [name, bytes] of input.assets ?? []) {
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(name)) throw new BoaaPackageError('invalid_package_entry');
    expanded += bytes.length;
    assets.set(name, bytes.slice());
  }
  if (expanded > BOAA_PACKAGE_LIMITS.expandedBytes) throw new BoaaPackageError('package_limit');
  const archive = await writePackageArchive({ ...input, manifest, assets, source: '' }, entries);
  await verifyPlatformPackage(archive);
  return archive;
}
export interface VerifiedSingleJs {
  readonly format: 'single-js';
  readonly digest: string;
  readonly sourceDigest: string;
  readonly manifest: PlatformManifest;
  readonly source: string;
  readonly original: Blob;
  readonly publisherFingerprint?: never;
}
/** Exact original bytes are the approved payload; a header never establishes a signed publisher. */
export async function verifyPlatformSingleJs(file: Blob, signal?: AbortSignal): Promise<VerifiedSingleJs> {
  signal?.throwIfAborted();
  if (!file.size || file.size > SOURCE_LIMIT) throw new BoaaPackageError('package_limit');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspected = inspectSingleJs(bytes);
  const sourceDigest = await packageSha256(bytes);
  const digest = await packageSha256(
    new TextEncoder().encode(JSON.stringify(['boaa.single-js/v1', sourceDigest, inspected.manifest])),
  );
  signal?.throwIfAborted();
  return { format: 'single-js', ...inspected, sourceDigest, digest, original: file };
}
