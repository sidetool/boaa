import { Client, type SFTPWrapper, type FileEntry, type Stats } from 'ssh2';
import { createHash } from 'node:crypto';
import {
  REMOTE_FILE_MAX_BYTES,
  REMOTE_FILE_MAX_ENTRIES,
  remoteFilePath,
  type RemoteFileEntry,
} from '../../../../packages/extension-contracts/remote-files.js';
import {
  failure,
  limitedStream,
  storageAddress,
  type RemoteFileSession,
  type SavedRemoteConnection,
} from './common.js';
function invoke<T>(run: (callback: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => run((e, value) => (e ? reject(e) : resolve(value))));
}
export async function openSftp(config: SavedRemoteConnection, signal: AbortSignal): Promise<RemoteFileSession> {
  const url = new URL(config.endpoint),
    address = await storageAddress(url.hostname),
    client = new Client();
  let hostKey = '',
    mismatch = false;
  signal.throwIfAborted();
  const abort = () => client.destroy();
  signal.addEventListener('abort', abort, { once: true });
  const close = () => {
    signal.removeEventListener('abort', abort);
    client.destroy();
  };
  let sftp: SFTPWrapper;
  try {
    await new Promise<void>((resolve, reject) => {
      client.on('error', (e) => reject(mismatch ? failure('host_key_changed') : e));
      client.once('close', () => reject(failure('unavailable')));
      client.once('ready', resolve);
      client.connect({
        host: address.address,
        port: Number(url.port) || 22,
        username: config.username,
        password: config.password || undefined,
        privateKey: config.privateKey || undefined,
        passphrase: config.passphrase || undefined,
        readyTimeout: 15_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer) => {
          hostKey = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          mismatch = !!config.hostKey && config.hostKey !== hostKey;
          return !mismatch;
        },
      });
    });
    sftp = await invoke<SFTPWrapper>((cb) => client.sftp(cb));
  } catch (e) {
    close();
    throw e;
  }
  const realpath = (p: string) => invoke<string>((cb) => sftp.realpath(p, cb));
  let root: string;
  try {
    root = remoteFilePath(await realpath(config.root));
  } catch (e) {
    close();
    throw e;
  }
  const resolve = async (p: string) => {
    p = remoteFilePath(p);
    const actual = remoteFilePath(await realpath((root === '/' ? '' : root) + (p === '/' ? '' : p) || '/'));
    if (actual !== root && root !== '/' && !actual.startsWith(root + '/')) throw failure('invalid_path');
    return actual;
  };
  return {
    hostKey,
    close,
    async list(path) {
      const actual = await resolve(path);
      const handle = await invoke<Buffer>((cb) => sftp.opendir(actual, cb));
      const result: RemoteFileEntry[] = [];
      const names = new Set<string>();
      try {
        for (;;) {
          signal.throwIfAborted();
          const rows = await invoke<FileEntry[] | false>((cb) =>
            sftp.readdir(handle, (error, entries) => {
              if ((error as (Error & { code?: number }) | undefined)?.code === 1) cb(undefined, false);
              else cb(error, entries);
            }),
          );
          if (rows === false) break;
          if (!rows.length) break;
          for (const row of rows) {
            if (row.filename === '.' || row.filename === '..') continue;
            if (
              !row.filename ||
              row.filename.includes('/') ||
              row.filename.includes('\\') ||
              Array.from(row.filename).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
              row.filename.length > 512 ||
              names.has(row.filename)
            )
              throw failure('invalid_response');
            names.add(row.filename);
            if (names.size > REMOTE_FILE_MAX_ENTRIES) throw failure('listing_limit');
            if (!((row.attrs.mode & 0o170000) === 0o040000) && !((row.attrs.mode & 0o170000) === 0o100000)) continue;
            if (!Number.isSafeInteger(row.attrs.size) || row.attrs.size < 0) throw failure('invalid_response');
            result.push({
              path: remoteFilePath(path + '/' + row.filename),
              name: row.filename,
              directory: (row.attrs.mode & 0o170000) === 0o040000,
              size: row.attrs.size,
              modified: new Date(row.attrs.mtime * 1000).toISOString(),
              revision: row.attrs.mtime + ':' + row.attrs.size,
            });
          }
        }
      } finally {
        await invoke<void>((cb) => sftp.close(handle, (e) => cb(e, undefined)));
      }
      return result;
    },
    async download(path) {
      const actual = await resolve(path),
        attrs = await invoke<Stats>((cb) => sftp.stat(actual, cb));
      if (!attrs.isFile()) throw failure('not_file');
      if (attrs.size > REMOTE_FILE_MAX_BYTES) throw failure('size_limit');
      return limitedStream(sftp.createReadStream(actual), signal);
    },
  };
}
