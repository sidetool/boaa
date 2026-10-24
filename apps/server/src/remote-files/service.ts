import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { SourceCredentialVault } from '../extensions/source-credential-vault.js';
import {
  REMOTE_FILE_EXTENSIONS,
  REMOTE_FILE_MAX_CONNECTIONS,
  remoteFilePath,
  type RemoteFileConnectionStatus,
  type RemoteFileProtocol,
} from '../../../../packages/extension-contracts/remote-files.js';
import { connectionInput, failure, type SavedRemoteConnection, type RemoteFileSession } from './common.js';
import { openWebDav } from './webdav.js';
import { openSftp } from './sftp.js';
import { RemoteListingCache } from './listing-cache.js';
import { RemoteListingStore } from './listing-store.js';
export type RemoteFileOpener = (config: SavedRemoteConnection, signal: AbortSignal) => Promise<RemoteFileSession>;
export class RemoteFileService {
  private readonly listings: RemoteListingCache;
  private active = new Map<string, number>();
  private epochs = new Map<string, number>();
  private epoch(owner: string, id: string) {
    return this.epochs.get(this.scope(owner, id)) ?? 0;
  }
  private bump(owner: string, id: string) {
    this.epochs.set(this.scope(owner, id), this.epoch(owner, id) + 1);
    this.listings.invalidate(owner, id);
  }
  constructor(
    private readonly vault: SourceCredentialVault,
    private readonly open: RemoteFileOpener = (c, s) => (c.protocol === 'webdav' ? openWebDav(c, s) : openSftp(c, s)),
    cacheDirectory?: string,
  ) {
    this.listings = new RemoteListingCache(
      Date.now,
      cacheDirectory ? new RemoteListingStore(cacheDirectory) : undefined,
    );
  }
  private scope(owner: string, id: string) {
    return JSON.stringify([owner, 'remote-files', id]);
  }
  private ids(owner: string): string[] {
    const saved = this.vault.read(this.scope(owner, 'index'));
    return saved ? (JSON.parse(saved.secret) as string[]) : [];
  }
  private read(owner: string, id: string): SavedRemoteConnection | undefined {
    if (!this.ids(owner).includes(id)) return undefined;
    const saved = this.vault.read(this.scope(owner, id));
    return saved ? (JSON.parse(saved.secret) as SavedRemoteConnection) : undefined;
  }
  statuses(owner: string): RemoteFileConnectionStatus[] {
    return this.ids(owner)
      .map((id) => this.status(owner, id))
      .filter((c) => c.connected);
  }
  status(owner: string, id: string): RemoteFileConnectionStatus {
    const c = this.read(owner, id);
    return c
      ? {
          connected: true,
          id: c.id,
          name: c.name,
          protocol: c.protocol,
          generation: c.generation,
          endpoint: c.endpoint,
          username: c.username,
          root: c.root,
          hostKey: c.hostKey,
        }
      : { connected: false };
  }
  private reserve(owner: string) {
    const n = this.active.get(owner) ?? 0;
    if (n >= 4) throw failure('busy');
    this.active.set(owner, n + 1);
    let done = false;
    return () => {
      if (!done) {
        done = true;
        const n = this.active.get(owner)! - 1;
        if (n) this.active.set(owner, n);
        else this.active.delete(owner);
      }
    };
  }
  async connect(owner: string, protocol: RemoteFileProtocol, value: unknown, signal: AbortSignal, existingId?: string) {
    const id = existingId ?? randomUUID();
    const before = this.read(owner, id),
      epoch = this.epoch(owner, id);
    if (existingId && !before) throw failure('not_connected');
    if (before && before.protocol !== protocol) throw failure('invalid_protocol');
    if (!before && this.ids(owner).length >= REMOTE_FILE_MAX_CONNECTIONS) throw failure('connection_limit');
    const release = this.reserve(owner);
    let session: RemoteFileSession | undefined;
    try {
      const input = connectionInput(protocol, value);
      const name = (value as Record<string, unknown>).name;
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 80 ||
        Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw failure('invalid_connection');
      // Pins survive edits to a saved server. A changed server identity needs deliberate removal and re-add.
      if (protocol === 'sftp' && before?.endpoint === input.endpoint) {
        if (input.hostKey && input.hostKey !== before.hostKey) throw failure('host_key_changed');
        input.hostKey = before.hostKey;
      }
      const config: SavedRemoteConnection = {
        ...input,
        protocol,
        name: name.trim(),
        root: input.root ?? '/',
        id,
        generation: randomUUID(),
      };
      signal.throwIfAborted();
      session = await this.open(config, signal);
      await session.check();
      signal.throwIfAborted();
      if (this.epoch(owner, id) !== epoch || this.read(owner, id)?.generation !== before?.generation)
        throw failure('connection_changed');
      if (protocol === 'sftp') {
        if (!session.hostKey) throw failure('invalid_host_key');
        config.hostKey = session.hostKey;
      }
      // Re-read after network work; synchronous writes serialize concurrent additions without lost IDs.
      const ids = this.ids(owner);
      if (!before && ids.length >= REMOTE_FILE_MAX_CONNECTIONS) throw failure('connection_limit');
      this.vault.write(this.scope(owner, id), { secret: JSON.stringify(config) });
      if (!before) {
        try {
          this.vault.write(this.scope(owner, 'index'), { secret: JSON.stringify([...ids, id]) });
        } catch (error) {
          this.vault.write(this.scope(owner, id), undefined);
          throw error;
        }
      }
      this.bump(owner, id);
      return this.status(owner, id);
    } finally {
      session?.close();
      release();
    }
  }
  disconnect(owner: string, id: string) {
    this.vault.write(this.scope(owner, 'index'), { secret: JSON.stringify(this.ids(owner).filter((x) => x !== id)) });
    this.bump(owner, id);
    this.vault.write(this.scope(owner, id), undefined);
    return { connected: false };
  }
  async use<T>(
    owner: string,
    id: string,
    generation: unknown,
    signal: AbortSignal,
    run: (session: RemoteFileSession, assertCurrent: () => void, close: () => void) => Promise<T>,
    keepOpen = false,
  ): Promise<T> {
    const release = this.reserve(owner);
    let session: RemoteFileSession | undefined,
      closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        session?.close();
        release();
      }
    };
    try {
      const config = this.read(owner, id);
      if (!config) throw failure('not_connected');
      if (generation !== config.generation) throw failure('connection_changed');
      const epoch = this.epoch(owner, id);
      const check = () => {
        signal.throwIfAborted();
        if (this.epoch(owner, id) !== epoch) throw failure('connection_changed');
      };
      session = await this.open(config, signal);
      check();
      const result = await run(session, check, close);
      check();
      if (!keepOpen) close();
      return result;
    } catch (e) {
      close();
      throw e;
    }
  }
  async list(owner: string, id: string, body: Record<string, unknown>, signal: AbortSignal) {
    const path = remoteFilePath(body.path ?? '/');
    const query = body.query ?? '';
    const cursor = body.cursor ?? '0';
    if (
      typeof query !== 'string' ||
      query.length > 256 ||
      typeof cursor !== 'string' ||
      (body.reload !== undefined && typeof body.reload !== 'boolean')
    )
      throw failure('invalid_request');
    const hash = createHash('sha256').update(query).digest('hex').slice(0, 32);
    const match = cursor === '0' ? undefined : /^([a-f0-9-]{36}):([0-9]{1,5}):([a-f0-9]{32})$/.exec(cursor);
    if (cursor !== '0' && !match) throw failure('invalid_request');
    const offset = match ? Number(match[2]) : 0;
    if (offset % 200 || offset >= 50_000 || (match && match[3] !== hash) || (match && body.reload))
      throw failure('invalid_request');
    const config = this.read(owner, id);
    if (!config) throw failure('not_connected');
    const epoch = this.epoch(owner, id);
    const check = () => {
      signal.throwIfAborted();
      if (
        body.generation !== config.generation ||
        this.read(owner, id)?.generation !== config.generation ||
        this.epoch(owner, id) !== epoch
      )
        throw failure('connection_changed');
    };
    check();
    const snapshot = await this.listings.get({
      owner,
      connection: id,
      key: JSON.stringify([owner, id, config.generation, path]),
      snapshot: match?.[1],
      reload: body.reload === true,
      signal,
      load: (scanSignal) =>
        this.use(owner, id, config.generation, scanSignal, async (session) =>
          (await session.list(path))
            .filter((e) => e.directory || REMOTE_FILE_EXTENSIONS.test(e.name))
            .sort(
              (a, b) =>
                Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }),
            ),
        ),
    });
    check();
    const all = query
      ? snapshot.entries.filter((e) => e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      : snapshot.entries;
    return {
      entries: all.slice(offset, offset + 200),
      nextCursor: offset + 200 < all.length ? `${snapshot.id}:${offset + 200}:${hash}` : undefined,
    };
  }
  async download(owner: string, id: string, body: Record<string, unknown>, signal: AbortSignal) {
    const path = remoteFilePath(body.path);
    if (!REMOTE_FILE_EXTENSIONS.test(path)) throw failure('unsupported_file');
    return this.use(
      owner,
      id,
      body.generation,
      signal,
      async (session, check, close) => {
        const stream = await session.download(path);
        const output = new Transform({
          transform(chunk, _encoding, done) {
            try {
              check();
              done(null, chunk);
            } catch {
              done(failure('connection_changed'));
            }
          },
        });
        stream.on('error', (error) => output.destroy(error));
        output.once('close', () => {
          stream.destroy();
          close();
        });
        stream.pipe(output);
        return output;
      },
      true,
    );
  }
}
