import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseVersion } from './feed.mjs';
const version = process.env.RELEASE_VERSION;
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const policy = JSON.parse(await readFile('deploy/release-policy.json', 'utf8'));
if (
  !releaseVersion(version) ||
  version.replace(/^v/, '') !== packageInfo.version ||
  policy.version !== packageInfo.version
)
  throw new Error('release_version_mismatch');
if (
  process.env.RELEASE_CANDIDATE !== 'true' &&
  execFileSync('git', ['rev-parse', `${version}^{commit}`], { encoding: 'utf8' }).trim() !==
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
)
  throw new Error('release_tag_mismatch');
const key = createPrivateKey(process.env.RELEASE_PRIVATE_KEY || '');
if (key.asymmetricKeyType !== 'ed25519') throw new Error('release_key_invalid');
const publicKey = createPublicKey(await readFile('deploy/release-public.pub')).export({ type: 'spki', format: 'pem' });
if (createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== publicKey)
  throw new Error('release_trust_mismatch');
