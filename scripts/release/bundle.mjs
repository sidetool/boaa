import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Explicit site-neutral allowlist. Never package a working directory or local provider tree.
const files = [
  'compose.release.yaml',
  '.env.example',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'deploy/release-public.pub',
  'deploy/release-management.md',
  'deploy/byedpi-integration.md',
  'deploy/minio/README.md',
  'services/runtime-components/README.md',
  'scripts/init-env.mjs',
  'scripts/release/install.mjs',
  'scripts/release/upgrade-updater.mjs',
  'scripts/release/deployment.mjs',
  'scripts/release/feed.mjs',
  'scripts/release/files.mjs',
  'scripts/release/verify-bundle.mjs',
];
const temporary = await mkdtemp(path.join(tmpdir(), 'boaa-install-'));
try {
  for (const file of files) {
    await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await cp(file, path.join(temporary, file));
  }
  await mkdir('release', { recursive: true });
  execFileSync('tar', ['-czf', path.resolve('release/boaa-install.tar.gz'), '-C', temporary, ...files]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
