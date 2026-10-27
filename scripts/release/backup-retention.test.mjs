import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, symlink, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planBackupRetention, pruneBackups } from './backup-retention.mjs';
const fixture = async (run) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'boaa-retention-'));
  try {
    for (let i = 1; i <= 5; i++) {
      const p = path.join(root, 'backups', 'b' + i);
      await mkdir(path.join(p, 'server'), { recursive: true });
      await writeFile(path.join(p, 'database.dump'), 'data');
      await writeFile(
        path.join(p, 'deployment.json'),
        JSON.stringify({ version: 'v1', config: '/state/c.json', compose: '/state/cmp.json' }),
      );
      await utimes(path.join(p, 'deployment.json'), i, i);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true });
  }
};
test('keeps newest three and a pinned migration snapshot; prunes only complete candidates', () =>
  fixture(async (root) => {
    await mkdir(path.join(root, 'backups', 'incomplete'));
    await symlink(path.join(root, 'backups', 'b1'), path.join(root, 'backups', 'linked'));
    const input = { keep: 3, maxBytes: 1e6, pins: ['b1'] };
    await writeFile(path.join(root, 'backup-retention.json'), JSON.stringify(input));
    const plan = await planBackupRetention(root, input);
    assert.deepEqual(
      plan.remove.map((v) => v.id),
      ['b2'],
    );
    const result = await pruneBackups(root);
    assert.deepEqual(
      result.removed.map((v) => v.id),
      ['b2'],
    );
    assert.ok((await readdir(path.join(root, 'backups'))).includes('linked'));
    assert.equal(result.kept.length, 4);
  }));
test('byte budget evicts old unpinned backups but never the newest recovery point', () =>
  fixture(async (root) => {
    const plan = await planBackupRetention(root, { keep: 3, maxBytes: 1, pins: [] });
    assert.deepEqual(
      plan.kept.map((v) => v.id),
      ['b5'],
    );
    assert.equal(plan.overBudget, true);
    assert.equal(plan.remove.length, 4);
  }));
test('refuses incomplete transactions and unsafe policy, protects explicit recovery IDs', () =>
  fixture(async (root) => {
    await writeFile(path.join(root, 'journal.json'), JSON.stringify({ phase: 'applying' }));
    await assert.rejects(pruneBackups(root), /busy/);
    await assert.rejects(planBackupRetention(root, { keep: 0 }), /invalid/);
    const plan = await planBackupRetention(root, { keep: 1, maxBytes: 1e6 }, ['b2']);
    assert.deepEqual(
      plan.kept.map((v) => v.id),
      ['b5', 'b2'],
    );
  }));
test('linked backup root is never traversed or removed', () =>
  fixture(async (root) => {
    const other = path.join(root, 'other');
    await mkdir(other);
    await symlink(path.join(root, 'backups'), path.join(other, 'backups'));
    await assert.rejects(planBackupRetention(other, {}), /unsafe/);
  }));
