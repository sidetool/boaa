import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteFileEntry } from '../../../../packages/extension-contracts/remote-files.js';
import { REMOTE_FILE_MAX_ENTRIES, remoteFilePath } from '../../../../packages/extension-contracts/remote-files.js';

export interface ListingSnapshot {
  id: string;
  key: string;
  owner: string;
  connection: string;
  createdAt: number;
  touchedAt: number;
  bytes: number;
  entries: RemoteFileEntry[];
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const MAX_FILE = 24 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_OWNER = 128 * 1024 * 1024;
export const listingBytes = (entries: RemoteFileEntry[]) =>
  Buffer.byteLength(JSON.stringify(entries)) * 2 + entries.length * 512;
/** Persistent account-isolated metadata, never credentials or file contents. Evicted by size, not age. */
export class RemoteListingStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private prefix(owner: string, connection: string) {
    return hash(owner) + '-' + hash(connection) + '-';
  }
  private file(owner: string, connection: string, key: string) {
    return path.join(this.root, this.prefix(owner, connection) + hash(key) + '.json');
  }
  read(owner: string, connection: string, key: string): Promise<ListingSnapshot | undefined> {
    return this.serial(async () => {
      const file = this.file(owner, connection, key);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) return;
        const row = JSON.parse(await readFile(file, 'utf8')) as ListingSnapshot;
        if (
          row.owner !== owner ||
          row.connection !== connection ||
          row.key !== key ||
          !/^[a-f0-9-]{36}$/.test(row.id) ||
          !Number.isFinite(row.createdAt) ||
          !Array.isArray(row.entries) ||
          row.entries.length > REMOTE_FILE_MAX_ENTRIES
        )
          return;
        const seen = new Set<string>();
        for (const e of row.entries) {
          if (
            !e ||
            typeof e.name !== 'string' ||
            !e.name ||
            e.name.length > 512 ||
            typeof e.directory !== 'boolean' ||
            remoteFilePath(e.path) !== e.path ||
            seen.has(e.path) ||
            e.name !== e.path.split('/').at(-1) ||
            (e.size !== undefined && (!Number.isSafeInteger(e.size) || e.size < 0))
          )
            return;
          seen.add(e.path);
        }
        row.bytes = listingBytes(row.entries);
        if (row.bytes > 48 * 1024 * 1024) return;
        row.touchedAt = Date.now();
        await utimes(file, new Date(), new Date());
        return row;
      } catch {
        return;
      }
    });
  }
  write(row: ListingSnapshot, signal: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal.throwIfAborted();
      const data = JSON.stringify(row);
      if (Buffer.byteLength(data) > MAX_FILE) return;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = this.file(row.owner, row.connection, row.key);
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
        signal.throwIfAborted();
        await rename(temp, file);
        await this.prune(hash(row.owner) + '-');
      } finally {
        await rm(temp, { force: true });
      }
    });
  }
  invalidate(owner: string, connection: string): Promise<void> {
    return this.serial(async () => {
      const prefix = this.prefix(owner, connection);
      for (const name of await readdir(this.root).catch(() => [] as string[]))
        if (name.startsWith(prefix) && name.endsWith('.json')) await rm(path.join(this.root, name), { force: true });
    });
  }
  private async prune(ownerPrefix: string) {
    const rows = [];
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue;
      const stat = await lstat(path.join(this.root, name));
      if (stat.isFile()) rows.push({ name, bytes: stat.size, time: stat.mtimeMs });
    }
    rows.sort((a, b) => a.time - b.time);
    let total = rows.reduce((n, r) => n + r.bytes, 0);
    let owned = rows.filter((r) => r.name.startsWith(ownerPrefix)).reduce((n, r) => n + r.bytes, 0);
    const removed = new Set<string>();
    for (const r of rows) {
      if (owned <= MAX_OWNER) break;
      if (!r.name.startsWith(ownerPrefix)) continue;
      await rm(path.join(this.root, r.name), { force: true });
      removed.add(r.name);
      owned -= r.bytes;
      total -= r.bytes;
    }
    let count = rows.length - removed.size;
    for (const r of rows) {
      if (count <= 512 && total <= MAX_TOTAL) break;
      if (removed.has(r.name)) continue;
      await rm(path.join(this.root, r.name), { force: true });
      count--;
      total -= r.bytes;
    }
  }
}
