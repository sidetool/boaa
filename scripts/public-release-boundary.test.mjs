import assert from 'node:assert/strict';
import test from 'node:test';
import { isForbiddenPublicPath, validatePublicFileList } from './public-release-boundary.mjs';

test('internal records and experimental harnesses cannot reenter a fresh public source snapshot', () => {
  for (const file of [
    'docs/archive/old-guide.md',
    'docs/design/example.md',
    'docs/decisions/example.md',
    'docs/BOAA-MIGRATION.md',
    'docs/platforms/desktop-next-work.md',
    'docs/operations/2026-10-17-review.md',
    'docs/operations/reader-ux-verification.md',
    'docs/extensions/javascript-plugin-g3-results.md',
    'docs/extensions/javascript-plugin-implementation-review.md',
    'docs/extensions/evidence/result.json',
    'docs/extensions/proposals/example.md',
    'docs/architecture/large-file-and-sync-architecture.md',
    'prototypes/ui-next/src/App.tsx',
    'scripts/plugins/g5-http/backend.ts',
    'scripts/plugins/p4/reader-worker.mjs',
    'services/webnovel-metadata-collector/docs/implementation-plan.md',
    'apps/server/src/extensions/mangayomi/fixtures/upstream/example.js.txt',
  ])
    assert.equal(isForbiddenPublicPath(file), true, file);
});

test('operational guides, current architecture, production tooling and synthetic tests stay public', () => {
  for (const file of [
    'docs/operations/docker-compose-guide-ko.md',
    'docs/operations/hosted-provider-admission.md',
    'docs/platforms/desktop.md',
    'docs/architecture/modular-reader-core.md',
    'docs/extensions/mangayomi-compatibility.md',
    'docs/extensions/boaapatch-format.md',
    'docs/releases/0.1.1-beta.1.md',
    'scripts/plugins/build-product-runtime.mjs',
    'scripts/plugins/platform-package.test.ts',
    'apps/server/src/routes/test-fixtures/plugin-backend.ts',
    'apps/server/src/extensions/mangayomi/fixtures/synthetic-sources.ts',
    'apps/server/src/extensions/mangayomi/fixtures/upstream/LICENSE',
  ])
    assert.equal(isForbiddenPublicPath(file), false, file);
  assert.deepEqual(validatePublicFileList(['README.md'], ['README.md']), { violations: [], missing: [] });
});
