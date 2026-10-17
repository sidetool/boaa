import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { uiManifestFixture } from '../../packages/extension-contracts/ui-test-fixture';
import { packBrowserUiProject } from './ui-package';
import { generatePublisherKey, loadPublisherKey } from '../extensions/signing';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), 'boaa-ui-package-'));
  dirs.push(dir);
  await mkdir(resolve(dir, 'dist'));
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(uiManifestFixture()));
  await writeFile(resolve(dir, 'dist/ui.js'), 'throw new Error("must not execute");');
  await writeFile(resolve(dir, 'LICENSE'), 'MIT');
  await writeFile(resolve(dir, 'package.json'), JSON.stringify({ scripts: { prepare: 'exit 1', build: 'exit 1' } }));
  return dir;
}
const exec = promisify(execFile);
const loader = resolve('apps/server/node_modules/tsx/dist/cli.mjs');
const cli = resolve('scripts/plugins/ui-cli.ts');
it('packs prebuilt bytes and supports offline publisher verification', async () => {
  const dir = await fixture();
  const { folder } = await generatePublisherKey(resolve(dir, 'key'));
  const key = await loadPublisherKey(resolve(folder, 'publisher.pem'));
  const pack = await packBrowserUiProject(dir, key);
  expect(pack.manifest.extension.id).toBe('org.example.wordbook');
  expect(pack.publisherFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(pack.source).toContain('must not execute');
});
it('CLI packs/checks from caller cwd, never overwrites output, fails closed on bad options and input', async () => {
  const dir = await fixture();
  const options = { cwd: dir, timeout: 30000 };
  const packed = await exec(process.execPath, [loader, cli, 'pack', '.', '--out', 'new.boaaext'], options);
  const checked = await exec(process.execPath, [loader, cli, 'check', 'new.boaaext'], options);
  expect(JSON.parse(packed.stdout)).toEqual(JSON.parse(checked.stdout));
  expect(JSON.parse(checked.stdout).inspectedOnly).toBe(true);
  const bytes = await readFile(resolve(dir, 'new.boaaext'));
  await expect(
    exec(process.execPath, [loader, cli, 'pack', '.', '--out', 'new.boaaext'], options),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readFile(resolve(dir, 'new.boaaext'))).toEqual(bytes);
  await expect(
    exec(process.execPath, [loader, cli, 'pack', '.', '--out', 'x', '--out', 'y'], options),
  ).rejects.toMatchObject({ code: 1 });
  await writeFile(resolve(dir, 'bad.boaaext'), 'not zip');
  await expect(exec(process.execPath, [loader, cli, 'check', 'bad.boaaext'], options)).rejects.toMatchObject({
    code: 1,
  });
}, 30000);
it('rejects symlinked code/directories and executable assets or extra entry points', async () => {
  const dir = await fixture();
  await writeFile(resolve(dir, 'outside.js'), 'code');
  await rm(resolve(dir, 'dist/ui.js'));
  await symlink(resolve(dir, 'outside.js'), resolve(dir, 'dist/ui.js'));
  await expect(packBrowserUiProject(dir)).rejects.toThrow('ui_dist_entry_denied');
  await rm(resolve(dir, 'dist'), { recursive: true });
  await mkdir(resolve(dir, 'other'));
  await symlink(resolve(dir, 'other'), resolve(dir, 'dist'));
  await expect(packBrowserUiProject(dir)).rejects.toThrow('ui_directory_denied');
  await rm(resolve(dir, 'dist'));
  await mkdir(resolve(dir, 'dist'));
  await writeFile(resolve(dir, 'dist/ui.js'), '');
  await writeFile(resolve(dir, 'dist/main.js'), '');
  await expect(packBrowserUiProject(dir)).rejects.toThrow('ui_dist_entry_denied');
  await rm(resolve(dir, 'dist/main.js'));
  await mkdir(resolve(dir, 'assets'));
  await writeFile(resolve(dir, 'assets/payload.js'), 'code');
  await expect(packBrowserUiProject(dir)).rejects.toThrow('ui_asset_denied');
});
it('rejects invalid text encoding rather than silently changing package bytes', async () => {
  const dir = await fixture();
  await writeFile(resolve(dir, 'dist/ui.js'), new Uint8Array([0xff]));
  await expect(packBrowserUiProject(dir)).rejects.toThrow();
});
