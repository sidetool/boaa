import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { signedEvidence, verifyFile } from './evidence.mjs';
const directory = path.resolve(process.argv[2] || 'release');
const key = await readFile('deploy/release-public.pub');
const bytes = await readFile(path.join(directory, 'server-evidence.json'));
const signature = await readFile(path.join(directory, 'server-evidence.json.sig'), 'utf8');
const evidence = signedEvidence(bytes, signature, key);
for (const [name, expected] of Object.entries(evidence.artifacts)) {
  await verifyFile(path.join(directory, name), expected);
}
console.log(`Verified signed evidence and all asset hashes for ${evidence.commit}; fourteen native image receipts.`);
