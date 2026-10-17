import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { IMAGE_NAMES, releaseVersion } from './feed.mjs';

const version = process.env.RELEASE_VERSION;
const owner = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase();
if (!releaseVersion(version) || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error('release_configuration_invalid');
const run = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const images = {};
for (const name of IMAGE_NAMES) {
  const image = `ghcr.io/${owner}/boaa-${name}`;
  const digests = [],
    sizes = [];
  for (const architecture of ['amd64', 'arm64']) {
    const metadata = JSON.parse(await readFile(`image-metadata/${name}-${architecture}.json`, 'utf8'));
    const digest = metadata['containerimage.digest'];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('release_digest_invalid');
    digests.push(`${image}@${digest}`);
    const manifest = JSON.parse(run(['buildx', 'imagetools', 'inspect', '--raw', `${image}@${digest}`]));
    if (!Array.isArray(manifest.layers)) throw new Error('release_image_manifest_invalid');
    sizes.push(manifest.layers.reduce((total, layer) => total + layer.size, 0));
  }
  const tag = `${image}:${version.replace(/^v/, '')}`;
  run(['buildx', 'imagetools', 'create', '--tag', tag, ...digests]);
  // Hash the exact registry response bytes; no mutable tag enters the signed deployment manifest.
  const raw = run(['buildx', 'imagetools', 'inspect', '--raw', tag]);
  const index = JSON.parse(raw);
  if (!index.manifests?.every((entry) => digests.includes(`${image}@${entry.digest}`)) || index.manifests.length !== 2)
    throw new Error('release_index_invalid');
  images[name] = {
    image,
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    platforms: ['linux/amd64', 'linux/arm64'],
    downloadBytes: Math.max(...sizes),
  };
}
await mkdir('release', { recursive: true });
await writeFile('release/images.json', JSON.stringify(images, null, 2) + '\n');
