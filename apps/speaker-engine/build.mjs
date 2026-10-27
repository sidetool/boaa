import { createRequire } from 'node:module';
// Reuse the existing server build dependency; the runtime bundle has no npm dependencies.
const { build } = createRequire(new URL('../server/package.json', import.meta.url))('esbuild');
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['apps/speaker-engine/src/index.ts'],
  outfile: 'apps/speaker-engine/dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@boaa/text-core': root + 'packages/text-core' },
  logLevel: 'warning',
});
