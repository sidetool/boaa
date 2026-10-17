import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { validateManifest } from './feed.mjs';

const repository = process.env.GITHUB_REPOSITORY || 'sidetool/boaa';
const version = process.env.RELEASE_VERSION;
const policy = JSON.parse(await readFile('deploy/release-policy.json', 'utf8'));
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
if (version?.replace(/^v/, '') !== packageInfo.version || policy.version !== packageInfo.version)
  throw new Error('release_version_mismatch');
const images = JSON.parse(await readFile(process.argv[2], 'utf8'));
const manifest = validateManifest(
  { format: 1, version: packageInfo.version, ...policy, updaterProtocol: 1, images },
  repository,
);
const key = createPrivateKey(process.env.RELEASE_PRIVATE_KEY || '');
if (key.asymmetricKeyType !== 'ed25519') throw new Error('release_key_invalid');
const publicKey = createPublicKey(key).export({ format: 'pem', type: 'spki' });
const trustedKey = await readFile('deploy/release-public.pem', 'utf8');
if (createPublicKey(trustedKey).export({ format: 'pem', type: 'spki' }) !== publicKey)
  throw new Error('release_trust_mismatch');
await mkdir('release', { recursive: true });
const data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile('release/release.json', data);
await writeFile('release/release.json.sig', sign(null, data, key).toString('base64') + '\n');
const archive = await readFile('release/boaa-install.tar.gz');
await writeFile('release/boaa-install.tar.gz.sig', sign(null, archive, key).toString('base64') + '\n');
