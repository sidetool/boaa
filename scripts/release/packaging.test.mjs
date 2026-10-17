import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { IMAGE_NAMES } from './feed.mjs';

test('release bundle is allowlisted, signed and rejects modified archive bytes', async (t) => {
  const root = path.resolve(import.meta.dirname, '../..');
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [
    'compose.release.yaml',
    '.env.example',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'deploy/release-policy.json',
    'deploy/release-management.md',
    'deploy/byedpi-integration.md',
    'services/runtime-components/README.md',
    'scripts/init-env.mjs',
    'scripts/release',
  ]) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await cp(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  await writeFile(path.join(directory, '.env'), 'SYNTHETIC_PRIVATE_VALUE=must-not-be-packaged\n');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await writeFile(path.join(directory, 'deploy/release-public.pub'), publicKey.export({ format: 'pem', type: 'spki' }));
  const run = (args) => execFileSync(process.execPath, args, { cwd: directory, stdio: 'pipe' });
  run(['scripts/release/bundle.mjs']);
  const archive = path.join(directory, 'release/boaa-install.tar.gz');
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listing.includes('compose.release.yaml'));
  assert.ok(listing.includes('scripts/release/install.mjs'));
  assert.ok(listing.includes('services/runtime-components/README.md'));
  assert.ok(!listing.includes('.env'));
  assert.ok(!listing.some((name) => /\.test\.|private|provider|node_modules/.test(name)));
  const images = Object.fromEntries(
    IMAGE_NAMES.map((name) => [
      name,
      {
        image: `ghcr.io/example/boaa-${name}`,
        digest: `sha256:${'a'.repeat(64)}`,
        platforms: ['linux/amd64', 'linux/arm64'],
        downloadBytes: 100,
      },
    ]),
  );
  await writeFile(path.join(directory, 'release/images.json'), JSON.stringify(images));
  const packageInfo = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  execFileSync(process.execPath, ['scripts/release/sign.mjs', 'release/images.json'], {
    cwd: directory,
    stdio: 'pipe',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'example/boaa',
      RELEASE_VERSION: `v${packageInfo.version}`,
      RELEASE_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    },
  });
  const verifyArgs = [
    'scripts/release/verify-bundle.mjs',
    'release/boaa-install.tar.gz',
    'release/boaa-install.tar.gz.sig',
    'deploy/release-public.pub',
  ];
  run(verifyArgs);
  await appendFile(archive, 'modified');
  assert.notEqual(spawnSync(process.execPath, verifyArgs, { cwd: directory, stdio: 'pipe' }).status, 0);
});
