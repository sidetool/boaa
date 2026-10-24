import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import {
  REMOTE_FILE_MAX_BYTES,
  remoteFilePath,
  type RemoteFileConnectionInput,
  type RemoteFileEntry,
  type RemoteFileProtocol,
} from '../../../../packages/extension-contracts/remote-files.js';
export interface SavedRemoteConnection extends RemoteFileConnectionInput {
  protocol: RemoteFileProtocol;
  name: string;
  id: string;
  generation: string;
  root: string;
}
export interface RemoteFileSession {
  check(): Promise<void>;
  list(path: string): Promise<RemoteFileEntry[]>;
  download(path: string): Promise<Readable>;
  close(): void;
  hostKey?: string;
}
export const failure = (code: string) => new Error('remote_files_' + code);
export function connectionInput(protocol: RemoteFileProtocol, value: unknown): RemoteFileConnectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_connection');
  const v = value as Record<string, unknown>;
  const text = (key: string, max: number, required = false) => {
    const value = v[key] ?? '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\0'))
      throw failure('invalid_connection');
    return value;
  };
  let endpoint = text('endpoint', 2048, true).trim();
  if (!endpoint.includes('://')) endpoint = (protocol === 'sftp' ? 'sftp://' : 'https://') + endpoint;
  const username = text('username', 256, true);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure('invalid_connection');
  }
  if (url.port === '0' || url.username || url.password || url.hash || url.search || !url.hostname)
    throw failure('invalid_connection');
  if (
    protocol === 'sftp'
      ? url.protocol !== 'sftp:' || (url.pathname !== '' && url.pathname !== '/')
      : !['https:', 'http:'].includes(url.protocol)
  )
    throw failure('invalid_connection');
  const allowHttp = text('allowHttp', 8);
  if (url.protocol === 'http:' && allowHttp !== 'true') throw failure('https_required');
  const password = text('password', 4096),
    privateKey = text('privateKey', 16384),
    passphrase = text('passphrase', 4096),
    hostKey = text('hostKey', 128).trim();
  if (protocol === 'sftp' && !password && !privateKey) throw failure('credentials_required');
  if (hostKey && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) throw failure('invalid_host_key');
  const root = remoteFilePath(text('root', 4096) || '/');
  if (protocol === 'webdav') {
    try {
      remoteFilePath(decodeURIComponent(url.pathname));
    } catch {
      throw failure('invalid_path');
    }
    url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  }
  return { endpoint: url.href, username, password, privateKey, passphrase, hostKey, root, allowHttp };
}
/** Owners may connect LAN/NAS servers. Metadata/link-local and non-unicast targets are never storage hosts. */
export async function storageAddress(host: string): Promise<{ address: string; family: 4 | 6 }> {
  host = host.replace(/^\[|\]$/g, '');
  const rows = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!rows.length) throw failure('unavailable');
  for (const { address } of rows) {
    const a = address.toLowerCase();
    if (
      a === '::' ||
      /^fe[89ab][0-9a-f]:/.test(a) ||
      a.startsWith('ff') ||
      a.startsWith('::ffff:') ||
      /^(0\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(a)
    )
      throw failure('invalid_host');
  }
  return rows[0] as { address: string; family: 4 | 6 };
}
export function limitedStream(input: Readable, signal: AbortSignal): Readable {
  let length = 0;
  const output = new Transform({
    transform(chunk: Buffer, _enc, done) {
      length += chunk.length;
      done(length > REMOTE_FILE_MAX_BYTES ? failure('size_limit') : null, chunk);
    },
  });
  const abort = () => {
    input.destroy(failure('cancelled'));
    output.destroy(failure('cancelled'));
  };
  const error = (e: Error) => output.destroy(e);
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  input.on('error', error);
  output.once('close', () => {
    signal.removeEventListener('abort', abort);
    input.destroy();
  });
  input.pipe(output);
  return output;
}
