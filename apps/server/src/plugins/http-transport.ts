import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { isPublicSourceAddress } from '@boaa/extension-runtime/source-http';
import {
  pluginEndpoint,
  pluginTarget,
  type PluginHttpRequest,
} from '../../../../packages/extension-contracts/plugin-http';
import { isUiJson, type UiJson } from '@boaa/extension-contracts/ui-json';
const lan = new BlockList();
lan.addSubnet('10.0.0.0', 8);
lan.addSubnet('172.16.0.0', 12);
lan.addSubnet('192.168.0.0', 16);
const forbiddenHeaders =
  /^(authorization|proxy-.*|cookie.*|host|origin|referer|connection|content-length|transfer-encoding|upgrade|te|trailer|expect|forwarded|x-forwarded-.*|sec-.*|accept-encoding)$/i;
export function credentialHeaderAllowed(header: string) {
  return /^[a-z][a-z0-9-]{0,63}$/.test(header) && (header === 'authorization' || !forbiddenHeaders.test(header));
}
export function privateOrigins(raw = '[]'): string[] {
  const values: unknown = JSON.parse(raw || '[]');
  if (
    !Array.isArray(values) ||
    values.length > 16 ||
    values.some((v) => typeof v !== 'string' || new URL(v).origin !== v || !lan.check(new URL(v).hostname, 'ipv4'))
  )
    throw Error('INVALID_PLUGIN_PRIVATE_ORIGINS');
  return values;
}
export async function approvePluginEndpoint(
  endpoint: string,
  boaaOrigin: string,
  allowed: string[],
  resolve = lookup,
  serverPort?: number,
) {
  const u = pluginEndpoint(endpoint);
  if (u.origin === boaaOrigin) throw Error('HTTP_ENDPOINT_DENIED');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host, { all: true, verbatim: true });
  const local = new Set(
    Object.values(networkInterfaces())
      .flat()
      .map((a) => a?.address),
  );
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const front = new URL(boaaOrigin);
  if (
    addresses.some((a) => local.has(a.address)) &&
    [serverPort, Number(front.port || (front.protocol === 'https:' ? 443 : 80))].includes(port)
  )
    throw Error('HTTP_ENDPOINT_DENIED');
  const privateApproved = allowed.includes(u.origin) && isIP(host) === 4 && lan.check(host, 'ipv4');
  if (
    (!privateApproved && u.protocol !== 'https:') ||
    !addresses.length ||
    addresses.some(
      (a) =>
        isIP(a.address) !== a.family || (!isPublicSourceAddress(a.address) && !(privateApproved && a.address === host)),
    )
  )
    throw Error('HTTP_ADDRESS_DENIED');
  return { url: u, address: addresses[0] };
}
export async function pluginHttpTransport(
  input: PluginHttpRequest,
  endpoint: string,
  credential: { header: string; value: string } | undefined,
  boaaOrigin: string,
  allowed: string[],
  allowedHeaders: string[],
  serverPort: number,
  signal: AbortSignal,
  beforeSend: () => Promise<void>,
): Promise<UiJson> {
  let dispatched = false;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(input.method);
  try {
    const target = pluginTarget(endpoint, input.path);
    const approved = await approvePluginEndpoint(endpoint, boaaOrigin, allowed, undefined, serverPort);
    const headers: Record<string, string> = { accept: 'application/json, text/plain', 'accept-encoding': 'identity' };
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (!allowedHeaders.includes(key) || forbiddenHeaders.test(key) || key === credential?.header)
        throw Error('HTTP_HEADER_DENIED');
      headers[key] = value;
    }
    if (credential) headers[credential.header] = credential.value;
    if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));
    await beforeSend();
    signal.throwIfAborted();
    const response = await new Promise<{ status: number; headers: Record<string, string>; text: string }>(
      (resolve, reject) => {
        const req = (target.protocol === 'https:' ? https : http)(
          target,
          {
            method: input.method,
            headers,
            signal,
            agent: false,
            maxHeaderSize: 8192,
            lookup: (_host, options, callback) =>
              queueMicrotask(() =>
                options.all
                  ? callback(null, [approved.address])
                  : callback(null, approved.address.address, approved.address.family),
              ),
          },
          (res) => {
            // No redirects, cookie jar, proxy inheritance or compressed-response expansion.
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
              res.destroy(Error('HTTP_ENCODING_DENIED'));
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 24 * 1024) res.destroy(Error('HTTP_RESPONSE_LIMIT'));
              else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              const safe: Record<string, string> = {};
              for (const key of ['content-type', 'etag', 'last-modified', 'retry-after', 'x-request-id']) {
                const v = res.headers[key];
                if (typeof v === 'string') safe[key] = v;
              }
              resolve({ status: res.statusCode ?? 0, headers: safe, text: Buffer.concat(chunks).toString('utf8') });
            });
          },
        );
        req.once('error', reject);
        dispatched = true;
        req.end(input.body);
      },
    );
    await beforeSend();
    signal.throwIfAborted();
    const result = {
      ok: true,
      status: response.status,
      headers: response.headers,
      body:
        input.response === 'json'
          ? input.method === 'HEAD' || [204, 205, 304].includes(response.status)
            ? null
            : (JSON.parse(response.text) as UiJson)
          : response.text,
    };
    if (!isUiJson(result, 56 * 1024)) throw Error('HTTP_RESPONSE_LIMIT');
    return result;
  } catch {
    return {
      ok: false,
      code: signal.aborted ? 'HTTP_CANCELLED' : 'HTTP_FAILED',
      outcome: dispatched && write ? 'unknown' : dispatched ? 'failed' : 'not-sent',
    };
  }
}
