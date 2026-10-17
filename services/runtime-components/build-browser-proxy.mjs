import { build } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
await build({
  entryPoints: ['apps/server/src/extensions/source-browser-proxy.ts'],
  outfile: '/out/source-browser-proxy.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@boaa/extension-runtime/source-http': './packages/extension-runtime/source-http.mjs' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
for (const name of ['socks', 'smart-buffer', 'ip-address', 'agent-base', 'https-proxy-agent', 'debug', 'ms']) {
  const source = join('node_modules', name);
  const target = join('/out/licenses', name);
  await mkdir(target, { recursive: true });
  for (const file of await readdir(source)) {
    if (file === 'package.json' || /^(license|copying)(\.|$)/i.test(file))
      await copyFile(join(source, file), join(target, file));
  }
}
