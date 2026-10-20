import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { IMAGE_NAMES, releaseVersion } from './feed.mjs';

const version = process.env.RELEASE_VERSION;
const owner = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase();
if (!releaseVersion(version) || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error('release_configuration_invalid');
const run = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const images = {},
  childImages = {};
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
for (const name of IMAGE_NAMES) {
  const image = `ghcr.io/${owner}/boaa-${name}`;
  const digests = [],
    sizes = [],
    children = {};
  for (const architecture of ['amd64', 'arm64']) {
    const metadata = JSON.parse(await readFile(`image-metadata/${name}-${architecture}.json`, 'utf8'));
    const digest = metadata['containerimage.digest'];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('release_digest_invalid');
    digests.push(`${image}@${digest}`);
    children[architecture] = digest;
    run(['pull', '--platform', `linux/${architecture}`, `${image}@${digest}`]);
    const [config] = JSON.parse(run(['image', 'inspect', `${image}@${digest}`]));
    if (
      config.Os !== 'linux' ||
      config.Architecture !== architecture ||
      config.Config.Labels?.['org.opencontainers.image.revision'] !== commit
    )
      throw new Error('release_child_platform_or_revision_invalid');
    const manifest = JSON.parse(run(['buildx', 'imagetools', 'inspect', '--raw', `${image}@${digest}`]));
    if (!Array.isArray(manifest.layers)) throw new Error('release_image_manifest_invalid');
    sizes.push(manifest.layers.reduce((total, layer) => total + layer.size, 0));
  }
  childImages[name] = children;
  const imageTag = process.env.BOAA_IMAGE_TAG || version.replace(/^v/, '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag)) throw new Error('image_tag_invalid');
  const tag = `${image}:${imageTag}`;
  run(['buildx', 'imagetools', 'create', '--tag', tag, ...digests]);
  // Hash the exact registry response bytes; no mutable tag enters the signed deployment manifest.
  const raw = run(['buildx', 'imagetools', 'inspect', '--raw', tag]);
  const index = JSON.parse(raw);
  if (
    index.manifests?.length !== 2 ||
    new Set(index.manifests.map((e) => e.platform?.architecture)).size !== 2 ||
    !index.manifests.every((e) => e.platform?.os === 'linux' && children[e.platform.architecture] === e.digest)
  )
    throw new Error('release_index_invalid');
  images[name] = {
    ...(name === 'metadata' ? { browserEngines: ['patchright', 'camoufox'] } : {}),
    image,
    ...(['browser', 'browser-camoufox'].includes(name)
      ? { engine: name === 'browser' ? 'patchright' : 'camoufox' }
      : {}),
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    platforms: ['linux/amd64', 'linux/arm64'],
    downloadBytes: Math.max(...sizes),
  };
}
await mkdir('release', { recursive: true });
await writeFile('release/images.json', JSON.stringify(images, null, 2) + '\n');
await writeFile('release/children.json', JSON.stringify(childImages, null, 2) + '\n');
