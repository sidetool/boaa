import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { install } from './install.mjs';
import { initializeEnv } from '../init-env.mjs';
import { IMAGE_NAMES } from './feed.mjs';

async function fixture(t, changeManifest = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-install-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'deploy'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyFile = path.join(directory, 'trusted.pem');
  await writeFile(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(
    path.join(directory, '.env.example'),
    'POSTGRES_PASSWORD=\nMINIO_ROOT_USER=\nMINIO_ROOT_PASSWORD=\nPROVIDER_SECRET_ENCRYPTION_KEY=\n',
  );
  const manifest = {
    format: 1,
    version: '1.0.0',
    minimumVersion: '1.0.0',
    schemaEpoch: 1,
    rollbackSafe: true,
    updaterProtocol: 1,
    images: Object.fromEntries(
      IMAGE_NAMES.map((name) => [
        name,
        {
          image: `ghcr.io/example/boaa-${name}`,
          digest: `sha256:${'a'.repeat(64)}`,
          platforms: ['linux/amd64', 'linux/arm64'],
          downloadBytes: 100,
          ...(name === 'browser' ? { engine: 'patchright' } : {}),
        },
      ]),
    ),
  };
  changeManifest(manifest);
  const data = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, data, privateKey).toString('base64');
  const calls = [];
  const options = {
    directory,
    keyFile,
    repository: 'example/boaa',
    version: 'v1.0.0',
    run: (args) => calls.push(args),
    fetcher: async (url) => new Response(String(url).endsWith('.sig') ? signature : data),
  };
  return { directory, options, calls };
}
test('verified initial install pins every image, generates secrets and starts Patchright with default services', async (t) => {
  const f = await fixture(t);
  await install(f.options);
  const override = JSON.parse(await readFile(path.join(f.directory, '.boaa-release/bootstrap.json'), 'utf8'));
  assert.equal(Object.keys(override.services).length, 8);
  assert.ok(Object.values(override.services).every((service) => service.image.includes('@sha256:')));
  for (const call of f.calls)
    for (const optional of ['runtime-apk', 'runtime-metadata']) assert.ok(!call.includes(optional));
  assert.match(await readFile(path.join(f.directory, '.env'), 'utf8'), /POSTGRES_PASSWORD=[a-f0-9]{64}/);
  await assert.rejects(install(f.options), /deployment_already_installed/);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) assert.ok(call.includes('runtime-browser'));
  assert.equal(override.services.api.environment.BOAA_SOURCE_BROWSER_ENDPOINT, 'http://runtime-browser:8791');
  assert.equal(override.services['runtime-browser'].environment.BOAA_BROWSER_ENGINE, 'patchright');
  assert.ok(!JSON.stringify(override).includes('boaa-browser-camoufox'));
});
test('invalid signature cannot write an install override or invoke Docker', async (t) => {
  const f = await fixture(t);
  f.options.fetcher = async () => new Response('{}');
  await assert.rejects(install(f.options), /release_signature_invalid/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(path.join(f.directory, '.boaa-release/bootstrap.json')), { code: 'ENOENT' });
});

test('explicit browser opt-out keeps the lightweight install and existing env untouched', async (t) => {
  const f = await fixture(t);
  initializeEnv(f.directory);
  const env = (await readFile(path.join(f.directory, '.env'), 'utf8')) + '\nBOAA_SOURCE_BROWSER_ENDPOINT=\n';
  await writeFile(path.join(f.directory, '.env'), env);
  await install({ ...f.options, browser: false });
  const override = JSON.parse(await readFile(path.join(f.directory, '.boaa-release/bootstrap.json'), 'utf8'));
  for (const call of f.calls) assert.ok(!call.includes('runtime-browser'));
  assert.equal(override.services.api.environment.BOAA_SOURCE_BROWSER_ENDPOINT, undefined);
  assert.equal(await readFile(path.join(f.directory, '.env'), 'utf8'), env);
});
test('default browser requires a signed Patchright image for the local architecture before installation', async (t) => {
  for (const change of [
    (manifest) => {
      delete manifest.images.browser.engine;
    },
    (manifest) => {
      manifest.images.browser.platforms = [process.arch === 'arm64' ? 'linux/amd64' : 'linux/arm64'];
    },
  ]) {
    const f = await fixture(t, change);
    await assert.rejects(install(f.options), /release_(browser|platform)_unsupported/);
    assert.deepEqual(f.calls, []);
    await assert.rejects(readFile(path.join(f.directory, '.boaa-release/bootstrap.json')), { code: 'ENOENT' });
  }
});
