import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateApkRuntimeManifest } from './apk-runtime-manifest.js';

it('checks managed payload version, executable and dependency paths before Java execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-runtime-manifest-'));
  try {
    const java = join(root, 'java/bin/java'),
      build = join(root, 'runtime');
    await mkdir(join(root, 'java/bin'), { recursive: true });
    await mkdir(join(build, 'dependencies'), { recursive: true });
    await mkdir(join(build, 'target'), { recursive: true });
    await writeFile(java, '', { mode: 0o755 });
    await writeFile(join(build, 'target/apk-worker-0.1.0.jar'), 'synthetic');
    const manifest = {
      schemaVersion: 1,
      protocolVersion: 1,
      component: 'apk',
      platform: process.platform,
      architecture: process.arch === 'x64' ? 'amd64' : 'arm64',
      version: '0.1.0',
      payload: { java: 'java/bin/java', runtime: 'runtime' },
    };
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    expect(await validateApkRuntimeManifest(java, build, true)).toEqual(manifest);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, protocolVersion: 2 }));
    await expect(validateApkRuntimeManifest(java, build, true)).rejects.toThrow('apk_runtime_manifest_invalid');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await symlink('/etc/passwd', join(build, 'dependencies/escape.jar'));
    await expect(validateApkRuntimeManifest(java, build, true)).rejects.toThrow('apk_runtime_path_denied');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
