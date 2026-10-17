import { buildProductPluginRuntime } from '../../scripts/plugins/build-product-runtime.mjs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(serverRoot, 'dist');

await rm(outdir, { force: true, recursive: true });

await build({
  absWorkingDir: serverRoot,
  alias: {
    '@boaa/extension-contracts/source-identity': '../../packages/extension-contracts/source-identity.mjs',
    '@boaa/reader-core/sync-contract': '../../packages/reader-core/sync-contract.ts',
    '@boaa/reader-core/search-policy': '../../packages/reader-core/search-policy.ts',
    '@boaa/reader-core/query-contract': '../../packages/reader-core/query-contract.ts',
    '@boaa/reader-core/discovery-settings': '../../packages/reader-core/discovery-settings.ts',

    '@boaa/reader-core/settings': '../../packages/reader-core/settings.ts',
    '@boaa/reader-core/defaults': '../../packages/reader-core/defaults.ts',
    '@boaa/reader-core/settings-scope': '../../packages/reader-core/settings-scope.ts',

    '@boaa/extension-contracts/source-protocol': '../../packages/extension-contracts/source-protocol.ts',
    '@boaa/extension-contracts/package': '../../packages/extension-contracts/package-manifest.ts',
    '@boaa/extension-contracts/ui-json': '../../packages/extension-contracts/ui-json.ts',
    '@boaa/extension-contracts/brand-compat': '../../packages/extension-contracts/brand-compat.ts',
    '@boaa/extension-contracts': '../../packages/extension-contracts/index.ts',
    '@boaa/contracts/sync': '../../packages/contracts/sync.ts',
    '@boaa/contracts': '../../packages/contracts/index.ts',
    '@boaa/document-series-core': '../../packages/document-series-core/index.ts',
    '@boaa/document-series-core/local-archive-series': '../../packages/document-series-core/local-archive-series.ts',
    '@boaa/epub-core': '../../packages/epub-core/index.ts',
    '@boaa/fixed-document-core/comic-source': '../../packages/fixed-document-core/comic-source.ts',
    '@boaa/fixed-document-core/series-image-archive': '../../packages/fixed-document-core/series-image-archive.ts',
    '@boaa/fixed-document-core': '../../packages/fixed-document-core/index.ts',
    '@boaa/text-core/hash': '../../packages/text-core/hash.ts',
    '@boaa/text-core/legacy-hash': '../../packages/text-core/legacy-hash.ts',
    '@boaa/text-core/normalization': '../../packages/text-core/normalization.ts',
    '@boaa/text-core/spoken-text': '../../packages/text-core/spoken-text.ts',
    '@boaa/text-core/parser': '../../packages/text-core/parser.ts',
    '@boaa/text-core/chapter-structure': '../../packages/text-core/chapter-structure.ts',
    '@boaa/text-core/image-format': '../../packages/text-core/image-format.ts',
    '@boaa/text-core/library-metadata': '../../packages/text-core/library-metadata.ts',
    '@boaa/text-core/speaker-attribution': '../../packages/text-core/speaker-attribution.ts',
    '@boaa/text-core/identity/parser': '../../packages/text-core/identity/parser.ts',
    '@boaa/text-core/identity/reader': '../../packages/text-core/identity/reader.ts',
    '@boaa/text-core/identity/ai': '../../packages/text-core/identity/ai.ts',
    '@boaa/text-core/identity/provider': '../../packages/text-core/identity/provider.ts',
    '@boaa/text-core/identity/sync': '../../packages/text-core/identity/sync.ts',
    '@boaa/text-core/identity/tts': '../../packages/text-core/identity/tts.ts',
    '@boaa/text-core/identity/workflow': '../../packages/text-core/identity/workflow.ts',
  },
  bundle: true,
  charset: 'utf8',
  entryPoints: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    'db/migrate': 'src/db/migrate.ts',
    'cli/id-v2-migration': 'src/cli/id-v2-migration.ts',
  },
  external: ['./db/migrate.js'],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  outdir,
  packages: 'external',
  platform: 'node',
  target: 'node22',
});

await mkdir(path.join(outdir, 'db'), { recursive: true });
await copyFile(path.join(serverRoot, 'src/db/schema.sql'), path.join(outdir, 'db/schema.sql'));

const migrationsSource = path.join(serverRoot, 'src/db/migrations');
const migrationsOutput = path.join(outdir, 'db/migrations');
const migrationFiles = (await readdir(migrationsSource, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort();

await mkdir(migrationsOutput, { recursive: true });
await Promise.all(
  migrationFiles.map((fileName) =>
    copyFile(path.join(migrationsSource, fileName), path.join(migrationsOutput, fileName)),
  ),
);

await buildProductPluginRuntime(path.join(outdir, 'plugin-runtime-assets'));
