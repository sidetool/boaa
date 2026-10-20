// Read-only operator review. CI still hashes and audits every full archive before signing.
import { execFileSync, spawn } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { signedEvidence, remoteArtifact, verifyFile } from './evidence.mjs';
import { releaseVersion, validateManifest } from './feed.mjs';

const { values } = parseArgs({
  options: {
    tag: { type: 'string' },
    commit: { type: 'string' },
    repository: { type: 'string', default: 'sidetool/boaa' },
    directory: { type: 'string' },
  },
});
const { tag, commit, repository } = values;
if (
  !releaseVersion(tag) ||
  !/^[a-f0-9]{40}$/.test(commit || '') ||
  !values.directory ||
  !/^[\w-]+\/[\w.-]+$/.test(repository)
)
  throw new Error('review_arguments_invalid');
const directory = path.resolve(values.directory);
await mkdir(directory, { recursive: true });
const api = (endpoint) =>
  execFileSync('gh', ['api', '--paginate', endpoint, '--jq', '.[] | @json'], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
// The tag endpoint cannot resolve an untagged draft. Resolve the exact tag from all pages.
const releases = api(`repos/${repository}/releases?per_page=100`).flat();
const matches = releases.filter((row) => row.tag_name === tag);
if (matches.length !== 1) throw new Error('review_release_missing_or_ambiguous');
const release = matches[0];
const assetsEndpoint = `repos/${repository}/releases/${release.id}/assets?per_page=100`;
const assets = api(assetsEndpoint).flat();
let downloadedBytes = 0,
  avoidedBytes = 0;
async function download(asset, expected) {
  const target = path.join(directory, asset.name);
  const temporary = `${target}.partial`;
  const child = spawn(
    'gh',
    ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`asset_download_failed: ${asset.name}`))));
  });
  try {
    await Promise.all([pipeline(child.stdout, createWriteStream(temporary, { mode: 0o600 })), exited]);
    if (expected) await verifyFile(temporary, expected);
    await rename(temporary, target);
    downloadedBytes += asset.size;
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(temporary, { force: true });
  }
}
for (const name of ['server-evidence.json', 'server-evidence.json.sig']) {
  const selected = assets.filter((asset) => asset.name === name);
  if (selected.length !== 1 || selected[0].size > 4 * 1024 * 1024) throw new Error('review_evidence_missing');
  await download(selected[0]);
}
const key = await readFile('deploy/release-public.pub');
const evidence = signedEvidence(
  await readFile(path.join(directory, 'server-evidence.json')),
  await readFile(path.join(directory, 'server-evidence.json.sig'), 'utf8'),
  key,
  commit,
);
const downloads = [];
for (const [name, expected] of Object.entries(evidence.artifacts)) {
  const { asset, download: fallback } = remoteArtifact(name, expected, assets);
  if (fallback || !name.endsWith('.tar.gz') || name === 'boaa-install.tar.gz') {
    downloads.push(() => download(asset, expected));
  } else {
    avoidedBytes += expected.bytes;
  }
}
for (let i = 0; i < downloads.length; i += 4) {
  const results = await Promise.allSettled(downloads.slice(i, i + 4).map((run) => run()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}
for (const name of ['release.json', 'boaa-install.tar.gz']) {
  const data = await readFile(path.join(directory, name));
  const signature = await readFile(path.join(directory, `${name}.sig`), 'utf8');
  if (!verify(null, data, createPublicKey(key), Buffer.from(signature.trim(), 'base64')))
    throw new Error(`review_signature_invalid: ${name}`);
}
const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'release.json'))), repository);
if (manifest.version !== tag.replace(/^v/, '')) throw new Error('review_version_mismatch');
for (const row of evidence.images) {
  const audit = JSON.parse(await readFile(path.join(directory, row.audit)));
  const smoke = JSON.parse(await readFile(path.join(directory, row.smoke)));
  if (
    audit.revision !== commit ||
    smoke.revision !== commit ||
    audit.imageId !== row.imageId ||
    smoke.imageId !== row.imageId ||
    audit.unresolved.length ||
    !smoke.tests.length ||
    smoke.tests.some((test) => test.passed !== true) ||
    manifest.images[row.component]?.digest !== row.indexDigest
  )
    throw new Error('review_image_receipt_invalid');
}
for (const arch of ['amd64', 'arm64']) {
  const integration = JSON.parse(await readFile(path.join(directory, `integration-${arch}.json`)));
  if (integration.commit !== commit || integration.architecture !== arch || integration.passed !== true)
    throw new Error('review_integration_invalid');
}
// Detect replacement/deletion during review, including changes to the signed evidence itself.
const after = api(assetsEndpoint).flat();
for (const before of assets) {
  const current = after.filter((row) => row.name === before.name);
  if (
    current.length !== 1 ||
    current[0].id !== before.id ||
    current[0].digest !== before.digest ||
    current[0].size !== before.size ||
    current[0].updated_at !== before.updated_at
  )
    throw new Error(`release_assets_changed_during_review: ${before.name}`);
}
const result = {
  tag,
  commit,
  releaseId: release.id,
  downloadedBytes,
  avoidedBytes,
  artifacts: Object.keys(evidence.artifacts).length,
};
await writeFile(path.join(directory, 'review-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
