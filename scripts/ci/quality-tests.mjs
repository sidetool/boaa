import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep local suites usable independently. Discover their union once so overlapping
// directory/file filters cannot duplicate tests across the execution phases.
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
  'apps/server/src/management',
  'apps/server/src/extensions/apk-runtime-manifest.test.ts',
  'apps/server/src/extensions/byedpi-process.test.ts',
  'apps/server/src/extensions/runtime-component-client.test.ts',
  'src/features/server-management',
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
  'src/features/auth',
  'src/storage/account-isolation.test.ts',
  'src/app/runtime/app-runtime.test.ts',
  'src/repositories/remote-reader-personalization-repository.test.ts',
  'apps/server/src/db/multi-account-data.integration.test.ts',
  'apps/server/src/db/account-boundary-regressions.integration.test.ts',
  'apps/server/src/services/self-host-auth-service.test.ts',
  'apps/server/src/routes/auth.test.ts',
  'apps/server/src/auth.test.ts',
  'apps/server/src/extensions/owner-runtime-registry.test.ts',
  'apps/server/src/extensions/owner-source-state.test.ts',
  'apps/server/src/routes/admin-sources.test.ts',
  'apps/server/src/routes/member-source-policy.test.ts',
  'src/external-sources/source-stream-buffer.test.ts',
  'src/extensions/platform',
  'apps/server/src/routes/plugin-runtime.integration.test.ts',
  'apps/server/src/routes/plugin-connections.integration.test.ts',
  'apps/server/src/plugins',
  'src/features/external-sources/use-source-download-recovery.test.tsx',
  'src/features/external-sources/use-source-subscription-refresh.test.tsx',
  'src/services/remote/remote-backup-transport.test.ts',
  'src/services/remote/remote-endpoint-transports.test.ts',
  'src/services/remote/audiobook-client.test.ts',
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
  'apps/server/src/services/audiobook-service.integration.test.ts',
  'apps/server/src/services/speaker-generation-plan.test.ts',
  'apps/server/src/services/speaker-generation.integration.test.ts',
  'apps/server/src/providers/speaker-engine-transport.test.ts',
  'apps/speaker-engine/src',
  'apps/server/src/routes/ai/plain-tts-routes.test.ts',
  'apps/server/src/routes/books/storage-routes.test.ts',
  'src/storage/library-storage-usage.test.ts',
  'apps/server/src/routes/backups.test.ts',
  'apps/server/src/services/backup-staging.test.ts',
  'apps/server/src/routes/books/original-file-routes.test.ts',
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
  'apps/server/src/services/hosted-bulk-write.integration.test.ts',
  'apps/server/src/routes/books/document-annotation-routes.test.ts',
  'apps/server/src/routes/books/request-contracts.test.ts',
  'src/features/external-sources/purged-source-library.test.ts',
  'src/features/import/import-controller.test.ts',
  'src/repositories/remote-document-annotation-repository.test.ts',
  'src/repositories/remote-shelf-order.test.ts',
  'src/services/remote/remote-reading-position.test.ts',
  'src/storage/library-management-store.test.ts',
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
const vitest = 'node_modules/vitest/vitest.mjs';

export function qualityTestPhases(files, root = process.cwd()) {
  const isolated = [];
  const parallel = [];
  for (const file of [...new Set(files)].sort()) {
    const path = relative(root, file).replaceAll('\\', '/');
    // These integration tests repeatedly start fresh Node/QuickJS processes.
    // Run each file without competing transform/test workers or retained realms
    // from another file. Guest, network and test deadlines remain unchanged.
    if (path.startsWith('apps/server/src/extensions/mangayomi/')) isolated.push({ files: [file], maxWorkers: 1 });
    else parallel.push(file);
  }
  return [...isolated, ...(parallel.length ? [{ files: parallel, maxWorkers: 2 }] : [])];
}

export function runQualityTests({ listOnly = false, spawn = spawnSync, log = console.log } = {}) {
  if (listOnly) {
    const result = spawn(process.execPath, [vitest, 'list', '--filesOnly', ...filters, '--maxWorkers=2'], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  // --filesOnly resolves file filters without loading test modules or starting helpers.
  const discovery = spawn(process.execPath, [vitest, 'list', '--filesOnly', ...filters, '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (discovery.error) throw discovery.error;
  if (discovery.status !== 0) return discovery.status ?? 1;
  const collected = JSON.parse(discovery.stdout);
  if (
    !Array.isArray(collected) ||
    !collected.length ||
    collected.some((entry) => typeof entry.file !== 'string' || entry.projectName)
  )
    throw new Error('Expected a non-empty single-project Quality file list');
  const phases = qualityTestPhases(collected.map((entry) => entry.file));
  let failed = false;
  for (const [index, phase] of phases.entries()) {
    log(`Quality phase ${index + 1}/${phases.length}: ${phase.files.length} file(s), ${phase.maxWorkers} worker(s)`);
    const result = spawn(process.execPath, [vitest, 'run', ...phase.files, `--maxWorkers=${phase.maxWorkers}`], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runQualityTests({ listOnly: process.argv.includes('--list') });
