import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validatePlatformManifest, type PlatformManifest } from '@boaa/extension-contracts/platform-package';

/** Synthetic, offline starter. Create a new directory only; never overwrite an existing project. */
export async function initializePlatformProject(folder: string, id: string, name: string) {
  const manifest: PlatformManifest = {
    packageFormat: 'boaa.extension.package',
    packageVersion: 3,
    apiVersion: 2,
    extension: { id, name, version: '0.1.0' },
    license: 'UNLICENSED',
    entries: { controller: { path: 'dist/controller.js', permissions: ['home.feed'] } },
    activation: ['onHome'],
    features: { required: ['home.feed'], optional: [] },
    contributes: {
      commands: [],
      views: [],
      decorations: [],
      homeSections: [{ id: 'popular', title: '오늘의 인기 작품' }],
    },
    requestedAccess: { storageKiB: 0, contentScopes: [] },
  };
  if (!validatePlatformManifest(manifest).ok || name.includes('*/')) throw Error('platform_invalid_metadata');
  const header = {
    id,
    name,
    version: '0.1.0',
    apiVersion: 2,
    license: manifest.license,
    activation: manifest.activation,
    permissions: ['home.feed'],
    features: ['home.feed'],
    contributes: { homeSections: manifest.contributes.homeSections },
  };
  const source = `/* @boaa-plugin ${JSON.stringify(header)} */
BoaaPlugin.register({
  apiVersion: 2,
  /** @param {import('@boaa/extension-contracts/platform-sdk').PlatformControllerContext} ctx */
  activate(ctx) {
    ctx.home.register('popular', async (signal) => {
      signal.throwIfAborted();
      return {
        items: [{ id: 'sample', title: '예제 작품', rank: 1 }],
        ttlSeconds: 1800,
      };
    });
  },
});
`;
  const root = resolve(folder);
  await mkdir(root, { mode: 0o700 });
  await mkdir(resolve(root, 'dist'), { mode: 0o700 });
  for (const [path, text] of [
    ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
    ['dist/controller.js', source],
    ['LICENSE', 'SPDX-License-Identifier: UNLICENSED\nAll rights reserved.\n'],
  ])
    await writeFile(resolve(root, path), text, { flag: 'wx', mode: 0o600 });
  return manifest;
}
