import { lstat, opendir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { validatePlatformManifest, type EntryRole } from '@boaa/extension-contracts/platform-package';
import { buildPlatformPackage, verifyPlatformPackage } from '../../src/extensions/packages/platform-package';
import { parsePlatformMetadata } from '../../src/extensions/packages/platform-metadata';
import { readBoundedUiFile } from './ui-package';
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
/** Read prebuilt files only. Never invoke a plugin, project scripts, dependency install or bundler. */
export async function packPlatformProject(folder: string, signingKey?: CryptoKeyPair) {
  const root = await realpath(folder);
  const metadata = await readBoundedUiFile(resolve(root, 'manifest.json'), 16384);
  const validation = validatePlatformManifest(parsePlatformMetadata(decode(metadata)));
  if (!validation.ok) throw new Error(validation.code);
  const manifest = validation.manifest;
  const dist = resolve(root, 'dist');
  if (!(await lstat(dist)).isDirectory()) throw new Error('platform_directory_denied');
  const paths = Object.values(manifest.entries).map((entry) => entry.path.slice('dist/'.length));
  for await (const entry of await opendir(dist))
    if (!entry.isFile() || !paths.includes(entry.name)) throw new Error('platform_dist_entry_denied');
  const sources: Partial<Record<EntryRole, string>> = {};
  let remaining = BOAA_PACKAGE_LIMITS.expandedBytes - metadata.length;
  for (const role of ['controller', 'ui', 'task'] as const) {
    const entry = manifest.entries[role];
    if (!entry) continue;
    const bytes = await readBoundedUiFile(
      resolve(root, entry.path),
      Math.min(remaining, BOAA_PACKAGE_LIMITS.entryBytes),
    );
    remaining -= bytes.length;
    sources[role] = decode(bytes);
  }
  const licenseBytes = await readBoundedUiFile(resolve(root, 'LICENSE'), remaining);
  remaining -= licenseBytes.length;
  let notices: string | undefined;
  try {
    const bytes = await readBoundedUiFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), remaining);
    remaining -= bytes.length;
    notices = decode(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const assets = new Map<string, Uint8Array>();
  const assetPath = resolve(root, 'assets');
  let hasAssets = false;
  try {
    if (!(await lstat(assetPath)).isDirectory()) throw new Error('platform_directory_denied');
    hasAssets = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (hasAssets)
    for await (const entry of await opendir(assetPath)) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(entry.name))
        throw new Error('platform_asset_denied');
      if (assets.size + paths.length + 5 >= BOAA_PACKAGE_LIMITS.entries) throw new Error('package_limit');
      const bytes = await readBoundedUiFile(resolve(assetPath, entry.name), remaining);
      remaining -= bytes.length;
      assets.set(entry.name, bytes);
    }
  return verifyPlatformPackage(
    await buildPlatformPackage({ manifest, sources, license: decode(licenseBytes), notices, assets, signingKey }),
  );
}
