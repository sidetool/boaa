import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { DockerDeployment } from './deployment.mjs';
import { readJson, atomicJson } from './files.mjs';
import { recordOperationResult } from './operation-results.mjs';

// Operator-only command, run under the same flock after stopping the updater service.
const deployment = new DockerDeployment();
await deployment.initialize({ allowDrift: true });
const journal = await readJson(path.join(deployment.directory, 'journal.json'), null);
if (
  journal &&
  !['complete', 'rolled-back', 'cancelled'].includes(journal.phase) &&
  journal.previous.schemaEpoch !== journal.target.schemaEpoch
)
  throw new Error('update_migration_required');
await deployment.apply(deployment.current);
await deployment.verify(deployment.current);
await deployment.assertCurrentMatches();
if (journal) await atomicJson(path.join(deployment.directory, 'journal.json'), { ...journal, phase: 'cancelled' });
const status = await readJson(path.join(deployment.directory, 'status.json'), {});
if (status.operation && !status.operation.completedAt)
  recordOperationResult(status, status.operation, 'failed', 'update_interrupted');
await atomicJson(path.join(deployment.directory, 'status.json'), {
  ...status,
  currentVersion: deployment.current.version,
  available: true,
  reason: undefined,
  error: undefined,
  phase: 'idle',
  busy: false,
  ...(status.operation ? { operation: { ...status.operation, completedAt: new Date().toISOString() } } : {}),
});
await unlink('/mailbox/maintenance.json').catch(() => {});
console.log('Saved managed deployment restored and verified. Start the updater service again.');
