import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeManifest } from './common.mjs';

function inside(root, path) {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith('../') && !isAbsolute(value);
}

async function validateTree(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!inside(root, await realpath(path))) throw new Error('apk_payload_path_denied');
    } else if (entry.isDirectory()) await validateTree(root, path);
    else if (!entry.isFile()) throw new Error('apk_payload_file_invalid');
  }
}

export async function writeApkManifest(root) {
  const digest = createHash('sha256');
  for (const name of ['runtime/build-inventory.json', 'runtime/target/apk-worker-0.1.0.jar', 'java/release'])
    digest.update(await readFile(join(root, name)));
  const manifest = {
    ...runtimeManifest('apk'),
    payloadDigest: digest.digest('hex'),
    payload: { java: 'java/bin/java', runtime: 'runtime' },
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
  return manifest;
}

/** The provider only writes executable payloads; installed extensions and preferences live in the API's data volume. */
export async function seedApkPayload(source, destination) {
  source = await realpath(source);
  destination = resolve(destination);
  if (inside(source, destination) || inside(destination, source)) throw new Error('apk_payload_path_denied');
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 1 ||
    manifest.component !== 'apk' ||
    !/^[a-f0-9]{64}$/.test(manifest.payloadDigest) ||
    manifest.payload?.java !== 'java/bin/java' ||
    manifest.payload?.runtime !== 'runtime'
  )
    throw new Error('apk_runtime_manifest_invalid');
  await validateTree(source);
  await mkdir(join(destination, 'releases'), { recursive: true, mode: 0o755 });
  const name = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const release = join(destination, 'releases', name);
  const staging = join(destination, 'releases', `.staging-${randomUUID()}`);
  const link = join(destination, `.current-${randomUUID()}`);
  try {
    if (!(await stat(release).catch(() => undefined))) {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      await validateTree(staging);
      await rename(staging, release);
    } else if (
      (await readFile(join(release, 'manifest.json'), 'utf8')) !==
      (await readFile(join(source, 'manifest.json'), 'utf8'))
    ) {
      throw new Error('apk_runtime_manifest_invalid');
    }
    await symlink(`releases/${name}`, link);
    await rename(link, join(destination, 'current'));
    return manifest;
  } finally {
    await rm(staging, { force: true, recursive: true });
    await rm(link, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'manifest') await writeApkManifest(process.argv[3] ?? '/payload');
  else await seedApkPayload('/payload', process.env.BOAA_APK_PAYLOAD_ROOT ?? '/opt/boaa-runtimes/apk');
}
