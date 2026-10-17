import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const runtimeRequire = createRequire(new URL('../../packages/extension-runtime/package.json', import.meta.url));
const { build } = require('esbuild');
export async function buildProductPluginRuntime(outdir) {
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'src/extensions/platform/guest/view-entry.ts')],
    bundle: true,
    outfile: path.join(outdir, 'view-bootstrap.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: true,
    define: { __BOAA_UI_PARENT_ORIGIN__: '__BOAA_CONFIGURED_PARENT_ORIGIN__' },
  });
  await build({
    entryPoints: [path.join(root, 'packages/extension-runtime/browser-controller/worker.mjs')],
    bundle: true,
    outfile: path.join(outdir, 'controller-worker.js'),
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    nodePaths: [path.join(root, 'packages/extension-runtime/node_modules')],
  });
  await copyFile(runtimeRequire.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'), path.join(outdir, 'quickjs.wasm'));
}
