import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { IMAGE_NAMES } from './feed.mjs';

export function signedEvidence(bytes, signature, publicKey, commit) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(signature.trim(), 'base64')))
    throw new Error('evidence_signature_invalid');
  const evidence = JSON.parse(bytes);
  if (!/^[a-f0-9]{40}$/.test(evidence.commit) || (commit && evidence.commit !== commit))
    throw new Error('evidence_commit_mismatch');
  const expected = IMAGE_NAMES.flatMap((name) => ['amd64', 'arm64'].map((arch) => `${name}/${arch}`));
  const actual = new Set(evidence.images.map((row) => `${row.component}/${row.architecture}`));
  if (
    evidence.images.length !== expected.length ||
    actual.size !== expected.length ||
    expected.some((id) => !actual.has(id))
  )
    throw new Error('evidence_image_matrix_invalid');
  for (const [name, row] of Object.entries(evidence.artifacts)) {
    if (!name || path.basename(name) !== name || name === '.' || name === '..' || name.includes('\\'))
      throw new Error('evidence_artifact_path_invalid');
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      throw new Error('evidence_artifact_hash_invalid');
  }
  return evidence;
}

// Stream archives rather than holding hundreds of MiB in the review process.
export async function verifyFile(file, expected) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > expected.bytes) throw new Error(`evidence_artifact_changed: ${path.basename(file)}`);
    hash.update(chunk);
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw new Error(`evidence_artifact_changed: ${path.basename(file)}`);
}

export function remoteArtifact(name, expected, assets) {
  const rows = assets.filter((row) => row.name === name);
  if (rows.length !== 1 || rows[0].state !== 'uploaded' || rows[0].size !== expected.bytes)
    throw new Error(`release_asset_missing_or_changed: ${name}`);
  const row = rows[0];
  // Old GitHub assets may lack digests. Download and hash these; never silently skip.
  if (row.digest == null || row.digest === '') return { asset: row, download: true };
  if (row.digest !== `sha256:${expected.sha256}`) throw new Error(`release_asset_digest_mismatch: ${name}`);
  return { asset: row, download: false };
}
