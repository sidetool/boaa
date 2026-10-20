import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signedEvidence, remoteArtifact, verifyFile } from './evidence.mjs';
import { registryEvidence } from './registry-evidence.mjs';
import { IMAGE_NAMES } from './feed.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const hash = (bytes) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
const commit = 'a'.repeat(40);
function fixture() {
  return {
    commit,
    artifacts: {},
    images: IMAGE_NAMES.flatMap((component) =>
      ['amd64', 'arm64'].map((architecture) => ({
        component,
        architecture,
        childDigest: `sha256:${'b'.repeat(64)}`,
        indexDigest: `sha256:${'c'.repeat(64)}`,
      })),
    ),
  };
}
const signed = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return [bytes, sign(null, bytes, privateKey).toString('base64'), pem, commit];
};

test('evidence must match the trusted signature, reviewed commit and complete native matrix', () => {
  const e = fixture();
  assert.equal(signedEvidence(...signed(e)).images.length, 14);
  const args = signed(e);
  args[0] = Buffer.from(JSON.stringify({ ...e, commit: 'd'.repeat(40) }));
  assert.throws(() => signedEvidence(...args), /signature/);
  assert.throws(() => signedEvidence(...signed({ ...e, commit: 'd'.repeat(40) })), /commit/);
  e.images[0] = e.images[1];
  assert.throws(() => signedEvidence(...signed(e)), /matrix/);
});

test('remote digest shortcut rejects missing, duplicate, resized and replaced assets', () => {
  const expected = hash('payload');
  const asset = { name: 'source.tar.gz', state: 'uploaded', size: expected.bytes, digest: `sha256:${expected.sha256}` };
  assert.equal(remoteArtifact(asset.name, expected, [asset]).download, false);
  assert.equal(remoteArtifact(asset.name, expected, [{ ...asset, digest: null }]).download, true);
  for (const rows of [
    [],
    [asset, asset],
    [{ ...asset, size: 1 }],
    [{ ...asset, state: 'new' }],
    [{ ...asset, digest: 'sha256:wrong' }],
  ]) {
    assert.throws(() => remoteArtifact(asset.name, expected, rows), /missing_or_changed|digest_mismatch/);
  }
});

test('unsafe archive paths and invalid byte counts cannot enter review', () => {
  for (const name of ['../escape', '.', '..', 'a\\b']) {
    assert.throws(() => signedEvidence(...signed({ ...fixture(), artifacts: { [name]: hash('x') } })), /path/);
  }
  assert.throws(
    () => signedEvidence(...signed({ ...fixture(), artifacts: { file: { ...hash('x'), bytes: -1 } } })),
    /hash/,
  );
});

test('streamed verification detects truncation and corruption without reading a whole archive into memory', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boaa-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture');
  await writeFile(file, 'payload');
  await verifyFile(file, hash('payload'));
  await assert.rejects(verifyFile(file, hash('payloa')), /changed/);
  await assert.rejects(verifyFile(file, hash('payloae')), /changed/);
  await assert.rejects(verifyFile(file, hash('payload-more')), /changed/);
});

test('only signed, successful, exact-child anonymous CI downloads can avoid a second pull', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'boaa-registry-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const e = fixture();
  const put = async (name, value) => {
    const bytes = JSON.stringify(value);
    e.artifacts[name] = hash(bytes);
    await writeFile(path.join(dir, name), bytes);
  };
  await put('images.json', Object.fromEntries(IMAGE_NAMES.map((name) => [name, { digest: e.images[0].indexDigest }])));
  const integrations = {};
  for (const arch of ['amd64', 'arm64']) {
    integrations[arch] = {
      commit,
      architecture: arch,
      passed: true,
      pulls: e.images
        .filter((r) => r.architecture === arch)
        .map((r) => ({ component: r.component, architecture: arch, anonymous: true, digest: r.childDigest })),
    };
  }
  async function save() {
    for (const arch of ['amd64', 'arm64']) await put(`integration-${arch}.json`, integrations[arch]);
    const [bytes, signature] = signed(e);
    await writeFile(path.join(dir, 'server-evidence.json'), bytes);
    await writeFile(path.join(dir, 'server-evidence.json.sig'), signature);
  }
  await save();
  assert.equal((await registryEvidence(dir, pem)).length, 14);
  integrations.amd64.pulls[0].anonymous = false;
  integrations.amd64.pulls[1].digest = `sha256:${'d'.repeat(64)}`;
  integrations.amd64.pulls.push(integrations.amd64.pulls[2]);
  delete integrations.arm64.pulls; // Old releases must still do full anonymous pulls.
  await save();
  assert.equal((await registryEvidence(dir, pem)).length, 4);
  await writeFile(path.join(dir, 'integration-amd64.json'), '{}');
  await assert.rejects(registryEvidence(dir, pem), /changed/);
  integrations.amd64.commit = 'e'.repeat(40);
  await save();
  await assert.rejects(registryEvidence(dir, pem), /integration/);
});
