import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Keep local suites usable independently; CI runs their union in one Vitest process.
// Vitest de-duplicates files even when a directory and a file filter overlap.
const suites = [
  'test:deploy',
  'test:extensions-sources',
  'test:ui-plugin-contracts',
  'test:ui-plugin-store',
  'test:plugin-platform-packages',
  'test:plugin-platform-store',
  'test:plugin-reader',
  'test:reader-recovery',
  'test:import-pages',
  'test:reader-ux',
  'test:web-local',
  'test:settings-ux',
];
const extraFilters = [
  'src/ui-next',
  'src/app/composition',
  'src/features/tts/useVoiceProfileEditor.test.tsx',
  'src/features/tts',
  'src/features/ai',
  'src/features/fixed-document',
  'src/features/reader/reader-decoration-store.test.ts',
  'src/features/reader/use-plugin-annotation-refresh.test.tsx',
  'src/features/reader/shared-paragraph-pages.test.tsx',
  'src/features/reader/paragraph-page-prefetch.test.ts',
  'src/features/reader/use-reader-scroll-position.test.tsx',
  'src/features/external-sources/SourceTextStreamReader.test.tsx',
  'src/features/auth/SelfHostAccountGate.test.tsx',
  'src/external-sources/source-stream-buffer.test.ts',
  'src/extensions/platform',
  'apps/server/src/routes/plugin-runtime.integration.test.ts',
  'apps/server/src/routes/plugin-connections.integration.test.ts',
  'apps/server/src/plugins',
  'src/features/external-sources/use-source-download-recovery.test.tsx',
  'src/features/external-sources/use-source-subscription-refresh.test.tsx',
  'src/services/remote/remote-backup-transport.test.ts',
  'src/services/remote/remote-endpoint-transports.test.ts',
  'src/test/sync-contract-versioning.test.ts',
  'apps/server/src/routes/sync',
  'src/features/external-sources/use-source-catalog-query.test.tsx',
  'src/features/external-sources/use-source-stream-session.test.tsx',
  'src/features/external-sources/use-source-automatic-download.test.tsx',
  'src/features/external-sources/source-owned-stream-port.test.ts',
  'apps/server/src/services/import',
  'apps/server/src/services/id-v2-migration/postgres-harness-lifetime.test.ts',
  'packages/reader-core',
  'apps/server/src/services/storage-capacity.test.ts',
  'apps/server/src/routes/books/storage-routes.test.ts',
  'src/storage/library-storage-usage.test.ts',
  'apps/server/src/routes/backups.test.ts',
  'apps/server/src/services/backup-staging.test.ts',
  'apps/server/src/routes/books/original-file-routes.test.ts',
  'src/features/library/OriginalFilesDialog.test.tsx',
  'src/repositories/original-file-download.test.ts',
  'src/features/fixed-document/ComicPageFlow.test.ts',
  'src/features/fixed-document/archive-page-loader.test.ts',
  'src/features/fixed-document/use-archive-page-images.test.tsx',
  'src/external-sources/source-cache-policy.test.ts',
  'src/external-sources/session-cover-cache.test.ts',
  'apps/server/src/extensions/source-cover-thumbnail.test.ts',
  'src/external-sources/local-state.test.ts',
  'src/features/discovery',
  'src/features/external-sources/useExternalSourceController.pagination.test.tsx',
  'apps/server/src/routes/books/discovery-settings-routes.integration.test.ts',
  'apps/server/src/routes/books/chapter-actions.integration.test.ts',
  'apps/server/src/routes/books/route-registration.test.ts',
  'src/external-sources/text-server',
  'src/external-sources/series',
  'src/external-sources/source-normalization.test.ts',
  'src/integration-settings',
  'src/features/book-workspace',
  'src/features/library',
  'src/features/external-sources/complete-series-catalog.test.ts',
  'src/features/external-sources/series-catalog-pagination.test.ts',
  'src/features/external-sources/source-cover.test.ts',
  'src/features/reader/ReaderChapterHeading.test.tsx',
  'src/test/import-expected-base.test.ts',
  'src/test/document-series-import.test.ts',
  'src/test/content-revision-remap-hash.test.ts',
  'src/features/import/local-document-series-import.test.ts',
  'src/services/import/browser-import-service.test.ts',
  'packages/document-series-core',
  'packages/extension-contracts',
  'apps/server/src/routes/text-source-gateway.test.ts',
  'apps/server/src/services/import-expected-base.integration.test.ts',
  'apps/server/src/services/book-revision/reader-state-restore.integration.test.ts',
];
const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const filters = new Set(extraFilters);
for (const suite of suites) {
  const command = scripts[suite].split(' && ')[0];
  if (!command.startsWith('vitest run ')) throw new Error(`Update the CI runner for ${suite}: ${command}`);
  for (const token of command.slice('vitest run '.length).split(/\s+/)) {
    if (/^--maxWorkers=\d+$/.test(token)) continue;
    if (token.startsWith('-')) throw new Error(`Handle ${suite}'s option in the CI runner: ${token}`);
    filters.add(token);
  }
}
const listOnly = process.argv.includes('--list');
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', ...(listOnly ? ['list', '--filesOnly'] : ['run']), ...filters, '--maxWorkers=2'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
