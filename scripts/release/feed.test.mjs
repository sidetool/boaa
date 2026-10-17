import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { compareVersions, ReleaseFeed, boundedDownload, validateManifest } from './feed.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const image = (name) => ({
  image: `ghcr.io/example/boaa-${name}`,
  digest: `sha256:${'a'.repeat(64)}`,
  platforms: ['linux/amd64'],
  downloadBytes: 123,
});
const manifest = {
  format: 1,
  version: '1.2.0',
  minimumVersion: '1.1.0',
  schemaEpoch: 1,
  rollbackSafe: true,
  updaterProtocol: 1,
  images: { web: image('web'), server: image('server') },
};
const bytes = Buffer.from(JSON.stringify(manifest));
const signature = sign(null, bytes, privateKey).toString('base64');
test('versions order stable after beta and compare numeric components', () => {
  assert.equal(compareVersions('v1.2.0', '1.2.0-beta.99'), 1);
  assert.equal(compareVersions('1.2.0-beta.10', '1.2.0-beta.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.2.0', 'v1.2.0'), 0);
  assert.throws(() => compareVersions('../release', '1.0.0'));
});
test('manifest is verified against a pinned Ed25519 key and repository image namespace', async () => {
  const feed = new ReleaseFeed({
    repository: 'example/boaa',
    publicKey: pem,
    fetcher: async (url) => new Response(String(url).endsWith('.sig') ? signature : bytes),
  });
  assert.deepEqual((await feed.manifest('v1.2.0')).manifest, manifest);
  const bad = structuredClone(manifest);
  bad.images.server.image = 'ghcr.io/attacker/boaa-server';
  assert.throws(() => validateManifest(bad, 'example/boaa'), /manifest_invalid/);
  const altered = new ReleaseFeed({
    repository: 'example/boaa',
    publicKey: pem,
    fetcher: async (url) =>
      new Response(String(url).endsWith('.sig') ? signature : JSON.stringify({ ...manifest, version: '1.3.0' })),
  });
  await assert.rejects(altered.manifest('1.3.0'), /signature_invalid/);
  await assert.rejects(feed.manifest('1.3.0'), /manifest_invalid/);
});
test('stable excludes prereleases, beta accepts stable and beta, neither includes drafts', async () => {
  const releases = [
    { tag_name: 'v2.0.0', draft: true },
    { tag_name: 'v1.3.0-beta.2', prerelease: true },
    { tag_name: 'v1.2.0', prerelease: false },
    { tag_name: 'development' },
  ];
  const feed = new ReleaseFeed({ fetcher: async () => Response.json(releases) });
  assert.deepEqual(
    (await feed.releases('stable')).map((row) => row.tag_name),
    ['v1.2.0'],
  );
  assert.deepEqual(
    (await feed.releases('beta')).map((row) => row.tag_name),
    ['v1.3.0-beta.2', 'v1.2.0'],
  );
});
test('downloads reject foreign redirects and both declared and streamed oversized bodies', async () => {
  await assert.rejects(
    boundedDownload('https://github.com/example/asset', {
      fetcher: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    }),
    /download_invalid/,
  );
  await assert.rejects(
    boundedDownload('https://github.com/example/asset', { limit: 2, fetcher: async () => new Response('abc') }),
    /size_limit/,
  );
  await assert.rejects(
    boundedDownload('https://github.com/example/asset', {
      limit: 2,
      fetcher: async () => new Response('', { headers: { 'content-length': '3' } }),
    }),
    /size_limit/,
  );
});
