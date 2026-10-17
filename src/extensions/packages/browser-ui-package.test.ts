import { expect, it } from 'vitest';
import { BlobReader, BlobWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { uiManifestFixture } from '../../../packages/extension-contracts/ui-test-fixture';
import { BOAA_PACKAGE_LIMITS } from '@boaa/extension-contracts/package';
import { buildBrowserUiPackage, verifyBrowserUiPackage } from './browser-ui-package';
import { buildBoaaExtension } from './package-builder';
import { verifyBoaaExtension, canonicalIntegrity, packageSha256 } from './package-archive';
import { writePackageArchive } from './package-archive-writer';
import { examplePackageManifest } from '../../test/extension-package-fixture';

const input = () => ({
  manifest: uiManifestFixture(),
  source: 'throw new Error("must never execute during preflight");',
  license: 'MIT',
});
const encode = (s: string) => new TextEncoder().encode(s);
async function mutate(
  archive: Blob,
  change: (files: Map<string, Uint8Array>) => void,
  rehash = false,
  symlink?: string,
) {
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
  for (const [path, bytes] of files)
    await writer.add(path, new Uint8ArrayReader(bytes), { level: 0, unixMode: symlink === path ? 0xa1ff : undefined });
  return writer.close();
}
it('inspects unsigned UI code without executing it and preserves V1/V2 routing', async () => {
  const archive = await buildBrowserUiPackage(input());
  const result = await verifyBrowserUiPackage(archive);
  expect(result.source).toBe(input().source);
  expect(result.publisherFingerprint).toBeUndefined();
  expect(result.manifest.packageVersion).toBe(2);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  await expect(verifyBoaaExtension(archive)).rejects.toMatchObject({ code: 'invalid_package_entry' });
  const v1 = await buildBoaaExtension({ ...input(), manifest: examplePackageManifest() });
  await expect(verifyBrowserUiPackage(v1)).rejects.toMatchObject({ code: 'invalid_package_entry' });
  expect((await verifyBoaaExtension(v1)).manifest.packageVersion).toBe(1);
});
it('rejects V2 manifests even if repackaged under the source entry path', async () => {
  const archive = await writePackageArchive(input(), 'dist/main.js');
  await expect(verifyBoaaExtension(archive)).rejects.toMatchObject({ code: 'invalid_package_manifest' });
});
it('binds publisher signature to code, permissions, metadata and assets', async () => {
  const signingKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const archive = await buildBrowserUiPackage({
    ...input(),
    signingKey,
    assets: new Map([['cover.png', new Uint8Array([1, 2])]]),
  });
  const verified = await verifyBrowserUiPackage(archive);
  expect(verified.publisherFingerprint).toBe(
    await packageSha256(new Uint8Array(await crypto.subtle.exportKey('spki', signingKey.publicKey))),
  );
  for (const [path, bytes] of [
    ['dist/ui.js', encode('changed')],
    ['assets/cover.png', new Uint8Array([3])],
    ['manifest.json', encode(JSON.stringify({ ...uiManifestFixture(), license: 'Apache-2.0' }))],
  ] as const) {
    await expect(
      verifyBrowserUiPackage(await mutate(archive, (files) => files.set(path, bytes), true)),
    ).rejects.toMatchObject({ code: 'invalid_package_signature' });
  }
  await expect(
    verifyBrowserUiPackage(await mutate(archive, (files) => files.set('signatures/publisher.json', encode('{}')))),
  ).rejects.toMatchObject({ code: 'invalid_package_signature' });
});
it('checks integrity independently of valid ZIP CRC', async () => {
  const archive = await buildBrowserUiPackage(input());
  await expect(
    verifyBrowserUiPackage(await mutate(archive, (files) => files.set('dist/ui.js', encode('tampered')))),
  ).rejects.toMatchObject({ code: 'invalid_package_integrity' });
  await expect(
    verifyBrowserUiPackage(
      await mutate(archive, (files) => files.set('integrity.json', encode('{"schemaVersion":1,"files":[]}'))),
    ),
  ).rejects.toMatchObject({ code: 'invalid_package_integrity' });
  await expect(verifyBrowserUiPackage(await mutate(archive, (files) => files.delete('LICENSE')))).rejects.toMatchObject(
    { code: 'incomplete_package' },
  );
});
it.each([
  'dist/UI.js',
  'dist/main.js',
  'assets/con.png',
  'assets/ui.svg',
  'index.html',
  'payload.exe',
  'assets/Cover.png',
])('rejects unexpected or case-colliding file %s', async (path) => {
  const archive = await buildBrowserUiPackage({ ...input(), assets: new Map([['cover.png', new Uint8Array([1])]]) });
  await expect(
    verifyBrowserUiPackage(await mutate(archive, (files) => files.set(path, encode('payload')), true)),
  ).rejects.toMatchObject({ code: 'invalid_package_entry' });
});
it('rejects archive symlinks, invalid UTF8 and oversized code before use', async () => {
  const archive = await buildBrowserUiPackage(input());
  await expect(
    verifyBrowserUiPackage(
      await mutate(archive, (files) => files.set('assets/link.png', encode('target')), true, 'assets/link.png'),
    ),
  ).rejects.toMatchObject({ code: 'invalid_package_entry' });
  await expect(
    verifyBrowserUiPackage(await mutate(archive, (files) => files.set('dist/ui.js', new Uint8Array([0xff])), true)),
  ).rejects.toMatchObject({ code: 'invalid_package_encoding' });
  await expect(
    buildBrowserUiPackage({ ...input(), source: 'x'.repeat(BOAA_PACKAGE_LIMITS.entryBytes + 1) }),
  ).rejects.toMatchObject({ code: 'package_limit' });
  await expect(
    verifyBrowserUiPackage(
      await writePackageArchive({ ...input(), source: 'x'.repeat(BOAA_PACKAGE_LIMITS.entryBytes + 1) }, 'dist/ui.js'),
    ),
  ).rejects.toMatchObject({ code: 'package_limit' });
  await expect(verifyBrowserUiPackage(new Blob(['not zip']))).rejects.toMatchObject({ code: 'invalid_package' });
  await expect(verifyBrowserUiPackage(archive, AbortSignal.abort())).rejects.toBeDefined();
});
it('rejects invalid UI permissions before signing or packaging', async () => {
  const manifest = uiManifestFixture();
  manifest.extension.permissions.push('native.invoke');
  await expect(buildBrowserUiPackage({ ...input(), manifest })).rejects.toMatchObject({ code: 'invalid_ui_manifest' });
  await expect(
    verifyBrowserUiPackage(await writePackageArchive({ ...input(), manifest }, 'dist/ui.js')),
  ).rejects.toMatchObject({ code: 'invalid_ui_manifest' });
});

it('enforces archive byte, entry count and total expanded byte ceilings', async () => {
  await expect(
    verifyBrowserUiPackage(new Blob([new Uint8Array(BOAA_PACKAGE_LIMITS.archiveBytes + 1)])),
  ).rejects.toMatchObject({ code: 'package_limit' });
  const assets = new Map(Array.from({ length: 254 }, (_, i) => [`a${i}.png`, new Uint8Array([1])]));
  const many = await writePackageArchive({ ...input(), assets }, 'dist/ui.js');
  await expect(verifyBrowserUiPackage(many)).rejects.toMatchObject({ code: 'package_limit' });
  const expanded = await writePackageArchive(
    { ...input(), license: 'x'.repeat(BOAA_PACKAGE_LIMITS.expandedBytes) },
    'dist/ui.js',
  );
  expect(expanded.size).toBeLessThan(BOAA_PACKAGE_LIMITS.archiveBytes);
  await expect(verifyBrowserUiPackage(expanded)).rejects.toMatchObject({ code: 'package_limit' });
});
