import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
const directory = path.resolve(process.argv[2] || 'release');
const key = createPublicKey(await readFile('deploy/release-public.pub'));
const bytes = await readFile(path.join(directory, 'server-evidence.json'));
const signature = Buffer.from(
  (await readFile(path.join(directory, 'server-evidence.json.sig'), 'utf8')).trim(),
  'base64',
);
if (!verify(null, bytes, key, signature)) throw new Error('evidence_signature_invalid');
const evidence = JSON.parse(bytes);
const identities = new Set(evidence.images.map((row) => `${row.component}/${row.architecture}`));
const expected = ['server', 'web', 'updater', 'apk', 'browser', 'metadata'].flatMap((name) =>
  ['amd64', 'arm64'].map((arch) => `${name}/${arch}`),
);
if (evidence.images.length !== 12 || identities.size !== 12 || expected.some((id) => !identities.has(id)))
  throw new Error('evidence_image_matrix_invalid');
for (const [name, expected] of Object.entries(evidence.artifacts)) {
  if (path.basename(name) !== name) throw new Error('evidence_artifact_path_invalid');
  const data = await readFile(path.join(directory, name));
  if (data.length !== expected.bytes || createHash('sha256').update(data).digest('hex') !== expected.sha256)
    throw new Error(`evidence_artifact_changed: ${name}`);
}
console.log(`Verified signed evidence and all asset hashes for ${evidence.commit}; twelve native image receipts.`);
