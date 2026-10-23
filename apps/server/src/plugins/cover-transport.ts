import { request } from 'node:https';
import { approvePluginEndpoint } from './http-transport';
import { publicImageUrl } from '../../../../packages/extension-contracts/home-feed';
import { pluginTarget } from '../../../../packages/extension-contracts/plugin-http';

export function coverMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
}
/** Public raster artwork only: DNS pinned, no redirects, cookies, credentials, or active image formats. */
export async function pluginCoverTransport(
  raw: string,
  endpoint: string,
  origin: string,
  signal: AbortSignal,
  beforeSend: () => Promise<void> = async () => {},
) {
  if (!publicImageUrl(raw)) throw Error('INVALID_COVER');
  const target = new URL(raw),
    base = new URL(endpoint);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw Error('COVER_DENIED');
  // Apply the same path rules as API requests before handing a URL to an upstream server.
  if (pluginTarget(endpoint, target.pathname.slice(base.pathname.length) + target.search).href !== target.href)
    throw Error('COVER_DENIED');
  const approved = await approvePluginEndpoint(endpoint, origin, [], undefined, 0);
  await beforeSend();
  signal.throwIfAborted();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      target,
      {
        signal,
        agent: false,
        maxHeaderSize: 8192,
        headers: { accept: 'image/png,image/jpeg,image/webp', 'accept-encoding': 'identity' },
        lookup: (_host, options, callback) =>
          queueMicrotask(() =>
            options.all
              ? callback(null, [approved.address])
              : callback(null, approved.address.address, approved.address.family),
          ),
      },
      (response) => {
        response.on('error', reject);
        if (
          response.statusCode !== 200 ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy(Error('COVER_DENIED'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512 * 1024) response.destroy(Error('COVER_LIMIT'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.end();
  });
  signal.throwIfAborted();
  const mime = coverMime(bytes);
  if (!mime) throw Error('INVALID_COVER');
  return { mime, data: bytes.toString('base64') };
}
