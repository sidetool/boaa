import { expect, it } from 'vitest';
import { BlobReader, BlobWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { buildPlatformPackage, verifyPlatformPackage, verifyPlatformSingleJs } from './platform-package';
import { inspectSingleJs } from './platform-single-js';
import { verifyBrowserUiPackage, buildBrowserUiPackage } from './browser-ui-package';
import { verifyBoaaExtension } from './package-archive';
import { uiManifestFixture } from '../../../packages/extension-contracts/ui-test-fixture';
import { canonicalIntegrity, packageSha256 } from './package-archive-core';
import type { PlatformManifest } from '@boaa/extension-contracts/platform-package';
const encode = (s: string) => new TextEncoder().encode(s);
const source = `/* @boaa-plugin ${JSON.stringify({
  id: 'org.example.passive',
  version: '1.0.0',
  apiVersion: 2,
  license: 'MIT',
  activation: ['onReader'],
  permissions: ['settings.own'],
  features: ['settings.schema'],
  contributes: {},
})} */\nthrow Error('Never execute during review');`;
const manifest = (): PlatformManifest => inspectSingleJs(encode(source)).manifest;
const input = () => ({ manifest: manifest(), sources: { controller: source }, license: 'MIT' });
async function rewrite(archive: Blob, change: (files: Map<string, Uint8Array>) => void, rehash = false) {
  const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
  const files = new Map<string, Uint8Array>();
  try {
    for await (const entry of reader.getEntriesGenerator())
      if (!entry.directory) files.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  } finally {
    await reader.close();
  }
  change(files);
  if (rehash)
    files.set(
      'integrity.json',
      encode(
        canonicalIntegrity(
          await Promise.all(
            [...files]
              .filter(([path]) => !['integrity.json', 'signatures/publisher.json'].includes(path))
              .map(async ([path, bytes]) => ({ path, size: bytes.length, sha256: await packageSha256(bytes) })),
          ),
        ),
      ),
    );
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  for (const [path, bytes] of files) await writer.add(path, new Uint8ArrayReader(bytes));
  return writer.close();
}
it('reviews controller-only packages without panel permission or code execution', async () => {
  const result = await verifyPlatformPackage(await buildPlatformPackage(input()));
  expect(result.sources).toEqual({ 'dist/controller.js': source });
  expect(result.manifest.entries.ui).toBeUndefined();
  expect(result.publisherFingerprint).toBeUndefined();
  expect(result).not.toHaveProperty('source');
});
it('preserves optional UI/task roles and their separate permissions', async () => {
  const m = manifest();
  m.entries.ui = { path: 'dist/ui.js', permissions: ['ui.render'] };
  m.entries.task = { path: 'dist/task.js', permissions: [] };
  m.features.required.push('ui.views');
  m.contributes.views.push('settings');
  const result = await verifyPlatformPackage(
    await buildPlatformPackage({
      ...input(),
      manifest: m,
      sources: { controller: source, ui: '//view', task: '//compute' },
    }),
  );
  expect(Object.keys(result.sources)).toHaveLength(3);
  expect(result.manifest.entries.task?.permissions).toEqual([]);
});
it('supports UI-only packages without implicitly inventing a controller', async () => {
  const m = manifest();
  m.entries = { ui: { path: 'dist/ui.js', permissions: ['ui.render'] } };
  m.features.required = ['ui.views'];
  m.activation = ['onView'];
  m.contributes.views = ['tool'];
  const result = await verifyPlatformPackage(
    await buildPlatformPackage({ ...input(), manifest: m, sources: { ui: '//view' } }),
  );
  expect(result.sources).toEqual({ 'dist/ui.js': '//view' });
});
it('does not reinterpret V1/V2/V3 profiles', async () => {
  const archive = await buildPlatformPackage(input());
  await expect(verifyBrowserUiPackage(archive)).rejects.toThrow();
  await expect(verifyBoaaExtension(archive)).rejects.toThrow();
  await expect(
    verifyPlatformPackage(
      await buildBrowserUiPackage({ manifest: uiManifestFixture(), source: '//ui', license: 'MIT' }),
    ),
  ).rejects.toThrow();
});
it('requires exactly the declared executable entries, including at authoring time', async () => {
  await expect(buildPlatformPackage({ ...input(), sources: {} })).rejects.toMatchObject({ code: 'incomplete_package' });
  await expect(
    buildPlatformPackage({ ...input(), sources: { controller: source, task: '//hidden' } }),
  ).rejects.toMatchObject({ code: 'undeclared_package_entry' });
  const archive = await buildPlatformPackage(input());
  await expect(
    verifyPlatformPackage(await rewrite(archive, (files) => files.set('dist/task.js', encode('//hidden')), true)),
  ).rejects.toMatchObject({ code: 'undeclared_package_entry' });
  await expect(
    verifyPlatformPackage(await rewrite(archive, (files) => files.delete('dist/controller.js'), true)),
  ).rejects.toMatchObject({ code: 'incomplete_package' });
});
it('verifies publisher signatures across code, roles, permissions and assets', async () => {
  const signingKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const signedManifest = manifest();
  signedManifest.entries.ui = { path: 'dist/ui.js', permissions: ['ui.render'] };
  signedManifest.entries.task = { path: 'dist/task.js', permissions: [] };
  signedManifest.features.required.push('ui.views');
  signedManifest.contributes.views.push('settings');
  const archive = await buildPlatformPackage({
    ...input(),
    manifest: signedManifest,
    sources: { controller: source, ui: '//view', task: '//compute' },
    signingKey,
    assets: new Map([['icon.png', new Uint8Array([1])]]),
  });
  const verified = await verifyPlatformPackage(archive);
  expect(verified.publisherFingerprint).toMatch(/^[a-f0-9]{64}$/);
  for (const path of ['dist/controller.js', 'dist/ui.js', 'dist/task.js', 'assets/icon.png']) {
    await expect(
      verifyPlatformPackage(await rewrite(archive, (files) => files.set(path, encode('changed')))),
    ).rejects.toMatchObject({ code: 'invalid_package_integrity' });
    await expect(
      verifyPlatformPackage(await rewrite(archive, (files) => files.set(path, encode('changed')), true)),
    ).rejects.toMatchObject({ code: 'invalid_package_signature' });
  }
  const changed = structuredClone(signedManifest);
  changed.activation = ['onAppSession'];
  await expect(
    verifyPlatformPackage(
      await rewrite(archive, (files) => files.set('manifest.json', encode(JSON.stringify(changed))), true),
    ),
  ).rejects.toMatchObject({ code: 'invalid_package_signature' });
});
it('rejects duplicate manifest keys, invalid UTF-8 and undeclared executable paths even with matching integrity', async () => {
  const archive = await buildPlatformPackage(input());
  const json = JSON.stringify(manifest()).replace('"apiVersion":2', '"apiVersion":1,"apiVersion":2');
  for (const [path, bytes] of [
    ['manifest.json', encode(json)],
    ['dist/controller.js', new Uint8Array([0xff])],
    ['assets/code.js', encode('//code')],
  ] as const)
    await expect(
      verifyPlatformPackage(await rewrite(archive, (files) => files.set(path, bytes), true)),
    ).rejects.toThrow();
});
it('binds single-JS approval identity to exact source and normalization, never claims a publisher', async () => {
  const first = await verifyPlatformSingleJs(new Blob([source]));
  expect(first.source).toBe(source);
  expect(await first.original.text()).toBe(source);
  expect(first.publisherFingerprint).toBeUndefined();
  expect(first.digest).not.toBe(first.sourceDigest);
  expect((await verifyPlatformSingleJs(new Blob([source]))).digest).toBe(first.digest);
  expect((await verifyPlatformSingleJs(new Blob([source + '\n']))).digest).not.toBe(first.digest);
});
it('honors cancellation and bounds before reading single-JS content', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(verifyPlatformSingleJs(new Blob([source]), abort.signal)).rejects.toThrow();
  await expect(verifyPlatformPackage(await buildPlatformPackage(input()), abort.signal)).rejects.toThrow();
  await expect(verifyPlatformSingleJs(new Blob([new Uint8Array(1024 * 1024 + 1)]))).rejects.toMatchObject({
    code: 'package_limit',
  });
});
