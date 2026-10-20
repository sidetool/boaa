import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, jsonResponse, readJson, runtimeManifest, runtimeToken } from './common.mjs';

import { camoufoxLaunchOptions, BROWSER_ENGINE, BROWSER_DRIVER_VERSION } from '@boaa/browser-runtime';
const ENGINES = new Set([BROWSER_ENGINE]);

export async function createBrowserWorker({
  token,
  openProxy = async (scope, signal) =>
    (await import('./source-browser-proxy.js')).openSourceBrowserProxy(scope, signal),
  launch = async () => {
    const { firefox } = await import('playwright-core');
    return firefox.launchServer({
      ...(await camoufoxLaunchOptions()),
      host: '127.0.0.1',
      port: 0,
      timeout: 30000,
    });
  },
  maxBrowsers = 4,
  idleMs = 5 * 60 * 1000,
  connectMs = 30000,
  lifetimeMs = 30 * 60 * 1000,
  onLaunchFailure = () => {},
} = {}) {
  token ??= await runtimeToken();
  const sessions = new Map();
  const manifest = { ...runtimeManifest('browser'), engines: { [BROWSER_ENGINE]: BROWSER_DRIVER_VERSION } };
  let closing = false;
  const stop = async (id) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    clearTimeout(entry.timer);
    clearTimeout(entry.lifetime);
    for (const socket of entry.sockets) socket.destroy();
    entry.controller?.abort();
    entry.proxy?.close();
    await entry.browser?.close().catch(() => undefined);
  };
  const touch = (id, timeout = idleMs) => {
    const entry = sessions.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void stop(id), timeout);
    entry.timer.unref();
  };
  const server = createServer(async (request, response) => {
    if (!authorized(request, token)) return jsonResponse(response, 401, { error: 'runtime_unauthorized' });
    if (request.method === 'GET' && ['/healthz', '/v1/manifest'].includes(request.url))
      return jsonResponse(response, 200, { ...manifest, status: 'ready', running: sessions.size });
    if (request.method !== 'POST' || request.url !== '/v1/browsers')
      return jsonResponse(response, 404, { error: 'runtime_path_denied' });
    let input;
    try {
      input = await readJson(request);
      if (
        !input ||
        input.protocolVersion !== 1 ||
        !ENGINES.has(input.engine) ||
        Object.keys(input).some((key) => !['protocolVersion', 'engine', 'proxyBridge'].includes(key))
      )
        throw new Error();
      if (input.proxyBridge) {
        const bridge = input.proxyBridge;
        const origins = (value) =>
          Array.isArray(value) &&
          value.length <= 64 &&
          value.every((origin) => {
            const url = new URL(origin);
            return ['https:', 'http:'].includes(url.protocol) && url.origin === origin;
          });
        if (
          !origins(bridge.origins) ||
          !origins(bridge.privateOrigins ?? []) ||
          (bridge.outboundProxy != null &&
            (typeof bridge.outboundProxy !== 'string' || bridge.outboundProxy.length > 2048)) ||
          Object.keys(bridge).some((key) => !['origins', 'privateOrigins', 'outboundProxy'].includes(key))
        )
          throw new Error();
      }
    } catch {
      return jsonResponse(response, 400, { error: 'runtime_input_invalid' });
    }
    if (closing || sessions.size >= maxBrowsers) return jsonResponse(response, 503, { error: 'runtime_busy' });
    const id = randomUUID();
    const entry = { sockets: new Set(), browser: undefined, timer: undefined, lifetime: undefined };
    sessions.set(id, entry);
    const cancel = () => {
      if (!response.writableFinished) void stop(id);
    };
    response.once('close', cancel);
    touch(id, connectMs);
    try {
      if (input.proxyBridge) {
        entry.controller = new AbortController();
        entry.proxy = await openProxy(
          {
            key: id,
            origins: input.proxyBridge.origins,
            privateOrigins: input.proxyBridge.privateOrigins ?? [],
            outboundProxy: input.proxyBridge.outboundProxy ?? undefined,
          },
          entry.controller.signal,
        );
      }
      const browser = await launch(input.engine);
      if (!sessions.has(id) || closing || response.destroyed) {
        await browser.close();
        return;
      }
      entry.browser = browser;
      browser.on('close', () => void stop(id));
      entry.lifetime = setTimeout(() => void stop(id), lifetimeMs);
      entry.lifetime.unref();
      return jsonResponse(response, 201, {
        ...manifest,
        engine: input.engine,
        wsPath: `/v1/browsers/${id}/ws`,
        ...(entry.proxy ? { proxy: entry.proxy.proxy, proxyBootstrapUrl: entry.proxy.bootstrapUrl } : {}),
      });
    } catch (error) {
      onLaunchFailure(error);
      await stop(id);
      if (!response.destroyed) jsonResponse(response, 503, { error: 'source_browser_unavailable' });
    } finally {
      response.removeListener('close', cancel);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 35000;
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => undefined);
    const match = /^\/v1\/browsers\/([a-f0-9-]{36})\/ws$/.exec(request.url ?? '');
    const entry = match && sessions.get(match[1]);
    if (!authorized(request, token) || !entry?.browser || entry.connected) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const id = match[1];
    entry.connected = true;
    entry.sockets.add(socket);
    socket.once('close', () => void stop(id));
    const target = new URL(entry.browser.wsEndpoint());
    const headers = { ...request.headers, host: target.host };
    delete headers.authorization;
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: target.port,
      path: target.pathname + target.search,
      method: 'GET',
      headers,
      timeout: 10000,
    });
    upstream.on('error', () => {
      socket.destroy();
      void stop(id);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('response', (response) => {
      response.resume();
      socket.destroy();
      void stop(id);
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      remote.on('error', () => undefined);
      if (socket.destroyed || !sessions.has(id)) {
        remote.destroy();
        return;
      }
      entry.sockets.add(remote);
      remote.once('close', () => void stop(id));
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
          .join('')}\r\n`,
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.on('data', () => touch(id));
      remote.on('data', () => touch(id));
      touch(id);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    upstream.end();
  });
  return {
    server,
    async close() {
      closing = true;
      await Promise.all([...sessions.keys()].map(stop));
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = await createBrowserWorker();
  worker.server.listen(Number(process.env.BOAA_RUNTIME_PORT || 8791), '0.0.0.0');
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => void worker.close());
}
