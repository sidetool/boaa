import { pinnedProxyAgent } from '../extensions/outbound-proxy';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { isPublicSourceAddress } from '@boaa/extension-runtime/source-http';
import {
  pluginEndpoint,
  pluginTarget,
  pluginJsonPick,
  type PluginHttpRequest,
} from '../../../../packages/extension-contracts/plugin-http';
import { isUiJson, type UiJson } from '@boaa/extension-contracts/ui-json';
import { pickPluginJson } from './json-pick';
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
  outboundProxy?: string,
): Promise<UiJson> {
  let dispatched = false;
  let agent: ReturnType<typeof pinnedProxyAgent>;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(input.method);
  try {
    if (input.pick !== undefined && (input.response !== 'json' || !pluginJsonPick(input.pick)))
      throw Error('HTTP_JSON_PICK_INVALID');
    const target = pluginTarget(endpoint, input.path);
    const approved = await approvePluginEndpoint(endpoint, boaaOrigin, allowed, undefined, serverPort);
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain',
      'accept-encoding': 'identity',
      'user-agent': 'BOAA/1.0',
    };
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      const ownOrigin = key === 'origin' && value === target.origin;
      if (!allowedHeaders.includes(key) || (forbiddenHeaders.test(key) && !ownOrigin) || key === credential?.header)
        throw Error('HTTP_HEADER_DENIED');
      headers[key] = value;
    }
    if (credential) headers[credential.header] = credential.value;
    if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));
    await beforeSend();
    signal.throwIfAborted();
    agent = pinnedProxyAgent(outboundProxy, target, approved.address.address, signal);
    const response = await new Promise<{ status: number; headers: Record<string, string>; text: string }>(
      (resolve, reject) => {
        const req = (target.protocol === 'https:' ? https : http)(
          target,
          {
            method: input.method,
            headers,
            signal,
            agent: agent ?? false,
            maxHeaderSize: 8192,
            lookup: (_host, options, callback) =>
              queueMicrotask(() =>
                options.all
                  ? callback(null, [approved.address])
                  : callback(null, approved.address.address, approved.address.family),
              ),
          },
          (res) => {
            // No redirects, cookie jar or compressed-response expansion.
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
              res.destroy(Error('HTTP_ENCODING_DENIED'));
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              const limit =
                input.pick && input.response === 'json' && (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300
                  ? 512 * 1024
                  : 24 * 1024;
              if (bytes > limit) res.destroy(Error('HTTP_RESPONSE_LIMIT'));
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
    let body: UiJson = response.text;
    if (input.response === 'json') {
      if (input.method === 'HEAD' || [204, 205, 304].includes(response.status)) body = null;
      else {
        try {
          body = JSON.parse(response.text) as UiJson;
        } catch (error) {
          // Error pages often contain HTML or no body. Preserve their HTTP status so
          // guests can distinguish login, challenges and throttling from outages.
          if (response.status >= 200 && response.status < 300) throw error;
          body = null;
        }
      }
    }
    if (input.pick && response.status >= 200 && response.status < 300 && body !== null) {
      body = pickPluginJson(body, input.pick) as UiJson;
      if (!isUiJson(body, 24 * 1024)) throw Error('HTTP_RESPONSE_LIMIT');
    }
    const result = { ok: true, status: response.status, headers: response.headers, body };
    if (!isUiJson(result, 56 * 1024)) throw Error('HTTP_RESPONSE_LIMIT');
    return result;
  } catch {
    return {
      ok: false,
      code: signal.aborted ? 'HTTP_CANCELLED' : 'HTTP_FAILED',
      outcome: dispatched && write ? 'unknown' : dispatched ? 'failed' : 'not-sent',
    };
  } finally {
    agent?.destroy();
  }
}
