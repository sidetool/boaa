import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { readDavResponses } from './webdav-xml.js';
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
const MAX_XML_BYTES = 32 * 1024 * 1024;
const propfind =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';
export async function openWebDav(config: SavedRemoteConnection, signal: AbortSignal): Promise<RemoteFileSession> {
  const base = new URL(config.endpoint),
    address = await storageAddress(base.hostname);
  const active = new Set<http.ClientRequest>();
  const root = remoteFilePath(decodeURIComponent(base.pathname));
  const urlFor = (path: string) => {
    const u = new URL(base);
    u.pathname = base.pathname + remoteFilePath(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return u;
  };
  const request = async (method: string, path: string, depth = 1): Promise<IncomingMessage> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const url = urlFor(path);
      if (method === 'PROPFIND' && !url.pathname.endsWith('/')) url.pathname += '/';
      const r = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method,
          signal,
          agent: false,
          hostname: address.address,
          servername: base.hostname.replace(/^\[|\]$/g, ''),
          headers: {
            Host: base.host,
            Authorization: 'Basic ' + Buffer.from(config.username + ':' + (config.password ?? '')).toString('base64'),
            'Accept-Encoding': 'identity',
            ...(method === 'PROPFIND'
              ? {
                  Depth: String(depth),
                  'Content-Type': 'application/xml; charset=utf-8',
                  'Content-Length': Buffer.byteLength(propfind),
                }
              : {}),
          },
        },
        (response) => {
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy();
            reject(failure('invalid_response'));
          } else if (response.statusCode === (method === 'PROPFIND' ? 207 : 200)) resolve(response);
          else {
            response.destroy();
            reject(
              failure(
                response.statusCode === 401 || response.statusCode === 403
                  ? 'authentication'
                  : response.statusCode === 404
                    ? 'not_found'
                    : response.statusCode && response.statusCode >= 300 && response.statusCode < 400
                      ? 'redirect'
                      : 'upstream',
              ),
            );
          }
        },
      );
      active.add(r);
      r.once('close', () => active.delete(r));
      r.on('error', reject);
      r.setTimeout(20_000, () => r.destroy(failure('timeout')));
      r.end(method === 'PROPFIND' ? propfind : undefined);
    });
  };
  return {
    close() {
      for (const r of active) r.destroy();
      active.clear();
    },
    async check() {
      let found = false;
      await readDavResponses(await request('PROPFIND', '/', 0), 64 * 1024, 1, (self) => {
        if (!self.href) throw failure('invalid_response');
        const url = new URL(self.href, urlFor('/'));
        if (
          url.origin !== base.origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          remoteFilePath(decodeURIComponent(url.pathname)) !== root
        )
          throw failure('invalid_response');
        if (!self.properties?.directory) throw failure('not_directory');
        found = true;
      });
      if (!found) throw failure('invalid_response');
    },
    async list(path) {
      path = remoteFilePath(path);
      const response = await request('PROPFIND', path);
      const result: RemoteFileEntry[] = [],
        seen = new Set<string>();
      await readDavResponses(response, MAX_XML_BYTES, REMOTE_FILE_MAX_ENTRIES + 1, (item) => {
        const href = item.href;
        if (!href) throw failure('invalid_response');
        let u: URL;
        try {
          const folder = urlFor(path);
          if (!folder.pathname.endsWith('/')) folder.pathname += '/';
          u = new URL(href, folder);
        } catch {
          throw failure('invalid_response');
        }
        if (
          u.origin !== base.origin ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          /%(?:2f|5c)/i.test(u.pathname)
        )
          throw failure('invalid_response');
        let absolute: string;
        try {
          absolute = remoteFilePath(decodeURIComponent(u.pathname));
        } catch {
          throw failure('invalid_response');
        }
        if (absolute !== root && root !== '/' && !absolute.startsWith(root + '/')) throw failure('invalid_response');
        const relative = remoteFilePath(root === '/' ? absolute : absolute.slice(root.length));
        if (relative === path) return;
        if (relative.slice(0, relative.lastIndexOf('/')) !== (path === '/' ? '' : path)) return;
        const props = item.properties;
        if (!props) return;
        const directory = props.directory;
        const size = !props.size ? undefined : Number(props.size);
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw failure('invalid_response');
        const time = Date.parse(props.modified ?? '');
        if (seen.has(relative)) throw failure('invalid_response');
        seen.add(relative);
        result.push({
          path: relative,
          name: relative.split('/').at(-1)!,
          directory,
          size,
          modified: Number.isFinite(time) ? new Date(time).toISOString() : undefined,
          revision: props.etag?.slice(0, 512) || undefined,
        });
      });
      return result;
    },
    async download(path) {
      const response = await request('GET', path);
      if (Number(response.headers['content-length']) > REMOTE_FILE_MAX_BYTES) {
        response.destroy();
        throw failure('size_limit');
      }
      return limitedStream(response, signal);
    },
  };
}
