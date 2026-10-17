import { createHash, createPublicKey, verify } from 'node:crypto';

export const IMAGE_NAMES = ['server', 'web', 'apk', 'browser', 'metadata', 'updater'];
export const UPDATER_PROTOCOL = 1;
export const releaseVersion = (value) =>
  typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(value);
export function compareVersions(a, b) {
  if (!releaseVersion(a) || !releaseVersion(b)) throw new Error('release_version_invalid');
  const parts = (value) =>
    value
      .replace(/^v/, '')
      .split(/\.|-beta\./)
      .map(Number);
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  const betaA = x[3] ?? Infinity,
    betaB = y[3] ?? Infinity;
  return betaA === betaB ? 0 : betaA > betaB ? 1 : -1;
}

export function validateManifest(value, repository) {
  const owner = repository.split('/')[0].toLowerCase();
  if (
    !value ||
    value.format !== 1 ||
    !releaseVersion(value.version) ||
    !releaseVersion(value.minimumVersion) ||
    compareVersions(value.minimumVersion, value.version) > 0 ||
    !Number.isSafeInteger(value.schemaEpoch) ||
    value.schemaEpoch < 1 ||
    typeof value.rollbackSafe !== 'boolean' ||
    value.updaterProtocol !== UPDATER_PROTOCOL ||
    !value.images ||
    typeof value.images !== 'object'
  )
    throw new Error('release_manifest_invalid');
  if (Object.keys(value.images).some((key) => !IMAGE_NAMES.includes(key)) || !value.images.server || !value.images.web)
    throw new Error('release_manifest_invalid');
  for (const [name, image] of Object.entries(value.images)) {
    if (
      !image ||
      image.image !== `ghcr.io/${owner}/boaa-${name}` ||
      !/^sha256:[a-f0-9]{64}$/.test(image.digest) ||
      !Array.isArray(image.platforms) ||
      !image.platforms.length ||
      image.platforms.some((p) => !['linux/amd64', 'linux/arm64'].includes(p)) ||
      !Number.isSafeInteger(image.downloadBytes) ||
      image.downloadBytes < 0
    )
      throw new Error('release_manifest_invalid');
  }
  return value;
}

export async function boundedDownload(url, { fetcher = fetch, limit = 1024 * 1024, headers = {} } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const target = new URL(current);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      ![
        'github.com',
        'api.github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(target.hostname)
    )
      throw new Error('release_download_invalid');
    const response = await fetcher(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('release_download_failed');
      current = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error([403, 429].includes(response.status) ? 'release_rate_limited' : 'release_download_failed');
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('release_size_limit');
    }
    if (!response.body) throw new Error('release_download_failed');
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('release_size_limit');
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      await reader.cancel();
    }
  }
  throw new Error('release_download_failed');
}

export class ReleaseFeed {
  constructor({ repository = 'sidetool/boaa', publicKey, fetcher = fetch } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository))
      throw new Error('release_repository_invalid');
    this.repository = repository;
    this.publicKey = publicKey;
    this.fetcher = fetcher;
  }
  async releases(channel = 'stable') {
    const raw = await boundedDownload(`https://api.github.com/repos/${this.repository}/releases?per_page=100`, {
      fetcher: this.fetcher,
      limit: 4 * 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json' },
    });
    const entries = JSON.parse(raw.toString());
    if (!Array.isArray(entries)) throw new Error('release_manifest_invalid');
    return entries
      .filter(
        (row) =>
          !row.draft &&
          releaseVersion(row.tag_name) &&
          (channel === 'beta' || (!row.prerelease && !row.tag_name.includes('-beta.'))),
      )
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  }
  async manifest(tag) {
    if (!releaseVersion(tag)) throw new Error('release_version_invalid');
    if (!this.publicKey) throw new Error('release_trust_unconfigured');
    const base = `https://github.com/${this.repository}/releases/download/${tag}`;
    const bytes = await boundedDownload(`${base}/release.json`, { fetcher: this.fetcher, limit: 65536 });
    const encoded = (await boundedDownload(`${base}/release.json.sig`, { fetcher: this.fetcher, limit: 256 }))
      .toString()
      .trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new Error('release_signature_invalid');
    const key = createPublicKey(this.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(encoded, 'base64')))
      throw new Error('release_signature_invalid');
    const manifest = validateManifest(JSON.parse(bytes.toString()), this.repository);
    if (compareVersions(manifest.version, tag) !== 0) throw new Error('release_manifest_invalid');
    return { manifest, digest: createHash('sha256').update(bytes).digest('hex') };
  }
}
