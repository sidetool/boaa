import { randomUUID } from 'node:crypto';
import type { RemoteFileEntry } from '../../../../packages/extension-contracts/remote-files.js';
import { REMOTE_FILE_MAX_ENTRIES } from '../../../../packages/extension-contracts/remote-files.js';
import { failure } from './common.js';
import { RemoteListingStore, listingBytes, type ListingSnapshot as Snapshot } from './listing-store.js';

const IDLE_MS = 30 * 60_000;
const MAX_BYTES = 64 * 1024 * 1024;
const OWNER_BYTES = 48 * 1024 * 1024;
interface Scan {
  owner: string;
  connection: string;
  abort: AbortController;
  consumers: number;
  promise: Promise<Snapshot>;
}
/** Server-only, bounded snapshots. Cursors stay on one snapshot even after a manual refresh. */
export class RemoteListingCache {
  private snapshots = new Map<string, Snapshot>();
  private pending = new Map<string, Scan>();
  private scans = 0;
  constructor(
    private readonly now = Date.now,
    private readonly store?: RemoteListingStore,
  ) {}
  invalidate(owner: string, connection: string) {
    const removal = this.store?.invalidate(owner, connection).catch(() => {});
    for (const [id, row] of this.snapshots)
      if (row.owner === owner && row.connection === connection) this.snapshots.delete(id);
    for (const [key, scan] of this.pending)
      if (scan.owner === owner && scan.connection === connection) {
        this.pending.delete(key);
        scan.abort.abort(failure('connection_changed'));
      }
    return removal;
  }
  private prune() {
    const now = this.now();
    for (const [id, row] of this.snapshots) if (now - row.touchedAt >= IDLE_MS) this.snapshots.delete(id);
  }
  private save(row: Snapshot) {
    if (row.bytes > OWNER_BYTES || row.entries.length > REMOTE_FILE_MAX_ENTRIES) throw failure('listing_limit');
    this.prune();
    const rows = [...this.snapshots.values()].sort((a, b) => a.touchedAt - b.touchedAt);
    let total = rows.reduce((n, s) => n + s.bytes, 0);
    let owner = rows.filter((s) => s.owner === row.owner).reduce((n, s) => n + s.bytes, 0);
    for (const old of rows) {
      if (owner + row.bytes > OWNER_BYTES && old.owner !== row.owner) continue;
      if (total + row.bytes <= MAX_BYTES && owner + row.bytes <= OWNER_BYTES && this.snapshots.size < 32) break;
      this.snapshots.delete(old.id);
      total -= old.bytes;
      if (old.owner === row.owner) owner -= old.bytes;
    }
    // Owner eviction can skip earlier foreign rows; finish global eviction if necessary.
    for (const old of this.snapshots.values()) {
      if (total + row.bytes <= MAX_BYTES && this.snapshots.size < 32) break;
      this.snapshots.delete(old.id);
      total -= old.bytes;
    }
    this.snapshots.set(row.id, row);
  }
  async get(input: {
    owner: string;
    connection: string;
    key: string;
    snapshot?: string;
    reload?: boolean;
    signal: AbortSignal;
    load(signal: AbortSignal): Promise<RemoteFileEntry[]>;
  }): Promise<Snapshot> {
    input.signal.throwIfAborted();
    this.prune();
    if (input.snapshot) {
      let row = this.snapshots.get(input.snapshot);
      if (!row && this.store) {
        const saved = await this.store.read(input.owner, input.connection, input.key);
        input.signal.throwIfAborted();
        if (saved?.id === input.snapshot) {
          this.save(saved);
          row = saved;
        }
      }
      if (!row || row.key !== input.key || row.owner !== input.owner) throw failure('listing_expired');
      row.touchedAt = this.now();
      return row;
    }
    if (!input.reload) {
      let row = [...this.snapshots.values()].reverse().find((s) => s.key === input.key && s.owner === input.owner);
      if (!row && this.store) {
        row = await this.store.read(input.owner, input.connection, input.key);
        input.signal.throwIfAborted();
        if (row) this.save(row);
      }
      if (row) {
        row.touchedAt = this.now();
        return row;
      }
    }
    let scan = this.pending.get(input.key);
    if (!scan) {
      // Bound concurrent upstream buffers/parsers as well as retained snapshots.
      if (this.scans >= 2) throw failure('busy');
      const abort = new AbortController();
      const next: Scan = { owner: input.owner, connection: input.connection, abort, consumers: 0, promise: undefined! };
      const deadline = setTimeout(() => abort.abort(failure('timeout')), 120_000);
      deadline.unref();
      this.scans++;
      this.pending.set(input.key, next);
      let cancelScan: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancelScan = () => reject(abort.signal.reason ?? failure('cancelled'));
        abort.signal.addEventListener('abort', cancelScan, { once: true });
      });
      // Cancellation can precede the load microtask and its race subscription.
      void cancelled.catch(() => {});
      next.promise = Promise.resolve()
        .then(async () => {
          abort.signal.throwIfAborted();
          const entries = await Promise.race([input.load(abort.signal), cancelled]);
          abort.signal.throwIfAborted();
          const row: Snapshot = {
            id: randomUUID(),
            key: input.key,
            owner: input.owner,
            connection: input.connection,
            entries,
            createdAt: this.now(),
            touchedAt: this.now(),
            // Conservative retained string/object accounting, separate from the wire response cap.
            bytes: listingBytes(entries),
          };
          this.save(row);
          try {
            await this.store?.write(row, abort.signal);
          } catch {
            /* An unavailable cache must not hide a valid listing. */
          }
          if (abort.signal.aborted) {
            this.snapshots.delete(row.id);
            abort.signal.throwIfAborted();
          }
          return row;
        })
        .finally(() => {
          clearTimeout(deadline);
          abort.signal.removeEventListener('abort', cancelScan);
          this.scans--;
          if (this.pending.get(input.key) === next) this.pending.delete(input.key);
        });
      scan = next;
    }
    const shared = scan;
    shared.consumers++;
    return new Promise<Snapshot>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, row?: Snapshot) => {
        if (done) return;
        done = true;
        input.signal.removeEventListener('abort', cancel);
        shared.consumers--;
        if (!shared.consumers && this.pending.get(input.key) === shared) {
          this.pending.delete(input.key);
          shared.abort.abort();
        }
        if (error) reject(error);
        else resolve(row!);
      };
      const cancel = () => finish(input.signal.reason ?? failure('cancelled'));
      input.signal.addEventListener('abort', cancel, { once: true });
      shared.promise.then(
        (row) => finish(undefined, row),
        (error: unknown) => finish(error),
      );
      if (input.signal.aborted) cancel();
    });
  }
}
