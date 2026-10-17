import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { validateBrowserUiManifest } from '@boaa/extension-contracts/ui-package';
import { buildBrowserUiPackage, verifyBrowserUiPackage } from '../../src/extensions/packages/browser-ui-package';

export async function readBoundedUiFile(path: string, maximum: number): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error('ui_file_denied');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('ui_file_limit');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maximum + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > stat.size || (await handle.stat()).size !== stat.size) throw new Error('ui_file_changed');
    if (offset !== stat.size) throw new Error('ui_file_changed');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
async function directory(path: string, optional = false): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('ui_directory_denied');
    return true;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Packages prebuilt bytes only. No project imports, bundler, npm scripts, describe(), or network. */
export async function packBrowserUiProject(folder: string, signingKey?: CryptoKeyPair) {
  const root = await realpath(folder);
  const manifest = JSON.parse(
    decode(await readBoundedUiFile(resolve(root, 'manifest.json'), BOAA_PACKAGE_LIMITS.manifestBytes)),
  ) as unknown;
  const validation = validateBrowserUiManifest(manifest);
  if (!validation.ok) throw new Error(validation.code);
  const dist = resolve(root, 'dist');
  await directory(dist);
  for await (const entry of await opendir(dist)) {
    if (entry.name !== 'ui.js' || !entry.isFile()) throw new Error('ui_dist_entry_denied');
  }
  const source = decode(await readBoundedUiFile(resolve(dist, 'ui.js'), BOAA_PACKAGE_LIMITS.entryBytes));
  let remaining =
    BOAA_PACKAGE_LIMITS.expandedBytes - new TextEncoder().encode(source).length - BOAA_PACKAGE_LIMITS.manifestBytes;
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
  if (await directory(assetPath, true)) {
    for await (const entry of await opendir(assetPath)) {
      if (assets.size >= BOAA_PACKAGE_LIMITS.entries - 6) throw new Error('ui_file_limit');
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(entry.name))
        throw new Error('ui_asset_denied');
      const bytes = await readBoundedUiFile(resolve(assetPath, entry.name), remaining);
      remaining -= bytes.length;
      assets.set(entry.name, bytes);
    }
  }
  const archive = await buildBrowserUiPackage({
    manifest,
    source,
    license: decode(licenseBytes),
    notices,
    assets,
    signingKey,
  });
  return verifyBrowserUiPackage(archive);
}
