import { access, readFile, realpath, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** Legacy explicit installations remain supported; managed payloads must satisfy this contract before Java runs. */
export async function validateApkRuntimeManifest(java: string, build: string, required = false) {
  const path = join(dirname(build), 'manifest.json');
  const raw = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !required) return undefined;
    throw new Error('apk_runtime_manifest_invalid');
  });
  if (!raw) return;
  if (raw.byteLength > 16384) throw new Error('apk_runtime_manifest_invalid');
  const manifest = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  const payload = manifest.payload as Record<string, unknown> | undefined;
  const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch as 'x64' | 'arm64'];
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 1 ||
    manifest.component !== 'apk' ||
    manifest.platform !== process.platform ||
    manifest.architecture !== architecture ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    payload?.java !== 'java/bin/java' ||
    payload.runtime !== 'runtime'
  )
    throw new Error('apk_runtime_manifest_invalid');
  const root = await realpath(dirname(build));
  const inside = async (value: string) => {
    const path = await realpath(value);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('apk_runtime_path_denied');
    return path;
  };
  if ((await inside(java)) !== join(root, 'java/bin/java') || (await inside(build)) !== join(root, 'runtime'))
    throw new Error('apk_runtime_path_denied');
  await access(java, constants.X_OK);
  await inside(join(build, 'target/apk-worker-0.1.0.jar'));
  for (const name of await readdir(join(build, 'dependencies'))) {
    if (name.endsWith('.jar')) await inside(join(build, 'dependencies', name));
  }
  return manifest;
}
