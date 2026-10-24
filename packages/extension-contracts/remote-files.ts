/** Built-in remote storage. References are paths within one saved connection, never arbitrary URLs. */
export type RemoteFileProtocol = 'webdav' | 'sftp';
export interface RemoteFileConnectionInput {
  endpoint: string;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  root?: string;
  hostKey?: string;
  allowHttp?: string;
}
export interface RemoteFileConnectionStatus {
  connected: boolean;
  name?: string;
  protocol?: RemoteFileProtocol;
  id?: string;
  generation?: string;
  endpoint?: string;
  username?: string;
  root?: string;
  hostKey?: string;
}
export interface RemoteFileCreateInput extends RemoteFileConnectionInput {
  protocol: RemoteFileProtocol;
  name: string;
}
export const REMOTE_FILE_MAX_CONNECTIONS = 16;
export interface RemoteFileEntry {
  path: string;
  name: string;
  directory: boolean;
  size?: number;
  modified?: string;
  revision?: string;
}
export interface RemoteFilePage {
  entries: RemoteFileEntry[];
  nextCursor?: string;
}
export const REMOTE_FILE_MAX_BYTES = 512 * 1024 * 1024;
export const REMOTE_FILE_MAX_ENTRIES = 50_000;
export const REMOTE_FILE_EXTENSIONS = /\.(txt|md|markdown|epub|pdf|zip|cbz|rar|cbr|7z|cb7)$/i;
export function remoteFilePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\\') ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('remote_files_invalid_path');
  const parts = value.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || p.length > 512)) throw new Error('remote_files_invalid_path');
  return '/' + parts.join('/');
}
export function remoteFileProtocol(value: unknown): RemoteFileProtocol {
  if (value !== 'webdav' && value !== 'sftp') throw new Error('remote_files_invalid_protocol');
  return value;
}
