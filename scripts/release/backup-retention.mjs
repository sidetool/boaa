import { createHash } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson } from './files.mjs';

const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
export const DEFAULT_BACKUP_RETENTION = { keep: 3, maxBytes: 8 * 1024 ** 3, pins: [] };
function policy(input) {
  const v = { ...DEFAULT_BACKUP_RETENTION, ...input };
  if (
    !Number.isInteger(v.keep) ||
    v.keep < 1 ||
    v.keep > 30 ||
    !Number.isSafeInteger(v.maxBytes) ||
    v.maxBytes < 1 ||
    !Array.isArray(v.pins) ||
    v.pins.length > 30 ||
    !v.pins.every(validId)
  )
    throw new Error('invalid_backup_retention');
  return v;
}
async function inspectTree(folder) {
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe_backup');
  let bytes = 0,
    entries = 0;
  const hash = createHash('sha256');
  async function visit(file, relative) {
    const s = await lstat(file);
    if (++entries > 200000 || s.dev !== root.dev || s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
      throw new Error('unsafe_backup');
    hash.update(JSON.stringify([relative, s.ino, s.size, s.mtimeMs]));
    if (s.isFile()) bytes += s.size;
    else for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
  }
  await visit(folder, '');
  return { bytes, signature: hash.digest('hex') };
}
/** Only complete managed snapshots are eligible; unknown, linked and incomplete entries are left alone. */
export async function planBackupRetention(directory, input, protect = []) {
  const p = policy(input),
    root = path.join(directory, 'backups');
  const candidates = [],
    skipped = [];
  let names;
  try {
    const s = await lstat(root);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe_backup_root');
    names = await readdir(root);
  } catch (e) {
    if (e.code === 'ENOENT') return { kept: [], remove: [], skipped, retainedBytes: 0, overBudget: false };
    throw e;
  }
  for (const id of names.sort()) {
    if (!validId(id)) {
      skipped.push(id);
      continue;
    }
    try {
      const folder = path.join(root, id),
        tree = await inspectTree(folder);
      const dump = await lstat(path.join(folder, 'database.dump'));
      const meta = await lstat(path.join(folder, 'deployment.json'));
      const server = await lstat(path.join(folder, 'server'));
      if (!dump.isFile() || !dump.size || !meta.isFile() || !server.isDirectory()) throw new Error('incomplete_backup');
      const saved = await readJson(path.join(folder, 'deployment.json'));
      if (
        !saved ||
        typeof saved.version !== 'string' ||
        typeof saved.config !== 'string' ||
        typeof saved.compose !== 'string'
      )
        throw new Error('incomplete_backup');
      candidates.push({ id, ...tree, createdAt: meta.mtimeMs });
    } catch {
      skipped.push(id);
    }
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const protectedIds = new Set([...p.pins, ...protect.filter(validId), candidates[0]?.id]);
  const kept = candidates.filter((v, index) => protectedIds.has(v.id) || index < p.keep);
  const remove = candidates.filter((v) => !kept.includes(v));
  let retainedBytes = kept.reduce((n, v) => n + v.bytes, 0);
  for (let i = kept.length - 1; i >= 0 && retainedBytes > p.maxBytes; i--) {
    if (protectedIds.has(kept[i].id)) continue;
    const [v] = kept.splice(i, 1);
    remove.push(v);
    retainedBytes -= v.bytes;
  }
  return { kept, remove, skipped, retainedBytes, overBudget: retainedBytes > p.maxBytes };
}
/** Caller must own the updater operation lock. Never run during a failed/incomplete recovery transaction. */
export async function pruneBackups(directory, protect = []) {
  const journal = await readJson(path.join(directory, 'journal.json'), null);
  if (journal && !['complete', 'rolled-back', 'cancelled'].includes(journal.phase))
    throw new Error('backup_retention_busy');
  const input = await readJson(path.join(directory, 'backup-retention.json'), DEFAULT_BACKUP_RETENTION);
  const plan = await planBackupRetention(directory, input, [...protect, journal?.operation?.id]);
  const removed = [];
  for (const item of plan.remove) {
    const folder = path.join(directory, 'backups', item.id);
    const now = await inspectTree(folder);
    if (now.signature !== item.signature) throw new Error('backup_changed_during_retention');
    await rm(folder, { recursive: true });
    removed.push({ id: item.id, bytes: item.bytes });
  }
  const result = {
    at: new Date().toISOString(),
    removed,
    kept: plan.kept.map(({ id, bytes }) => ({ id, bytes })),
    skipped: plan.skipped,
    retainedBytes: plan.retainedBytes,
    overBudget: plan.overBudget,
  };
  await atomicJson(path.join(directory, 'backup-retention-last.json'), result);
  return result;
}
