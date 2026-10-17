// Operator-only registry tag promotion after independent review and creation of the final Git tag.
// This does not publish a GitHub release or change package visibility.
import { readFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { IMAGE_NAMES, releaseVersion } from './feed.mjs';
const tag = process.env.RELEASE_VERSION;
const owner = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase();
if (!releaseVersion(tag) || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error('promotion_configuration_invalid');
const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
const bytes = await readFile('release/server-evidence.json');
const signature = Buffer.from((await readFile('release/server-evidence.json.sig', 'utf8')).trim(), 'base64');
const key = createPublicKey(await readFile('deploy/release-public.pub'));
if (!verify(null, bytes, key, signature)) throw new Error('evidence_signature_invalid');
const evidence = JSON.parse(bytes);
if (evidence.commit !== commit) throw new Error('reviewed_commit_mismatch');
const imageBytes = await readFile('release/images.json');
if (createHash('sha256').update(imageBytes).digest('hex') !== evidence.artifacts['images.json'].sha256)
  throw new Error('reviewed_images_changed');
const images = JSON.parse(imageBytes);
if (Object.keys(images).length !== IMAGE_NAMES.length) throw new Error('promotion_image_matrix_invalid');
for (const name of IMAGE_NAMES) {
  const expected = `ghcr.io/${owner}/boaa-${name}`;
  const image = images[name];
  if (image?.image !== expected || !/^sha256:[a-f0-9]{64}$/.test(image.digest))
    throw new Error('promotion_image_invalid');
  const visibility = execFileSync(
    'gh',
    ['api', `users/${owner}/packages/container/boaa-${name}`, '--jq', '.visibility'],
    { encoding: 'utf8' },
  ).trim();
  if (visibility !== 'private') throw new Error('promotion_requires_private_package');
  const target = `${expected}:${tag.replace(/^v/, '')}`;
  execFileSync('docker', ['buildx', 'imagetools', 'create', '--tag', target, `${expected}@${image.digest}`], {
    stdio: 'inherit',
  });
  const raw = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', target]);
  if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== image.digest)
    throw new Error('promotion_index_digest_changed');
}
console.log(`Promoted six reviewed private image indexes for ${tag}; release draft and visibility unchanged.`);
