import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, jsonResponse, readJson, runtimeManifest, runtimeToken } from './common.mjs';

import { browserLaunchOptions, browserLauncher, BROWSER_ENGINE, browserDriverVersion } from '@boaa/browser-runtime';
const ENGINES = new Set([BROWSER_ENGINE]);

export async function createBrowserWorker({
  token,
  openProxy = async (scope, signal) =>
    (await import('./source-browser-proxy.js')).openSourceBrowserProxy(scope, signal),
  launch = async () => {
    const launcher = await browserLauncher();
    return launcher.launchServer({
      ...(await browserLaunchOptions()),
      host: '127.0.0.1',
      port: 0,
      timeout: 30000,
    });
  },
  maxQueued = 8,
  queueMs = 15000,
  idleMs = 60000,
  connectMs = 30000,
  lifetimeMs = 30 * 60 * 1000,
  onLaunchFailure = () => {},
} = {}) {
  token ??= await runtimeToken();
  const sessions = new Map();
  const manifest = {
    ...runtimeManifest('browser'),
    engines: { [BROWSER_ENGINE]: browserDriverVersion(BROWSER_ENGINE) },
  };
  let closing = false;
  let active = 0;
  const waiting = [];
  const drain = () => {
    if (!closing && active === 0) waiting.shift()?.start();
  };
  const acquire = (entry) =>
    new Promise((resolve, reject) => {
      const queued = {
        start() {
          clearTimeout(entry.queueTimer);
          entry.cancelQueued = undefined;
          entry.reserved = true;
          active++;
          resolve();
        },
      };
      entry.cancelQueued = () => {
        const index = waiting.indexOf(queued);
        if (index >= 0) waiting.splice(index, 1);
        clearTimeout(entry.queueTimer);
        reject(new Error('runtime_busy'));
      };
      if (active === 0) queued.start();
      else {
        waiting.push(queued);
        entry.queueTimer = setTimeout(entry.cancelQueued, queueMs);
        entry.queueTimer.unref();
      }
    });
  const stop = (id) => {
    const entry = sessions.get(id);
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    entry.stopped = true;
    entry.stopping = Promise.resolve().then(async () => {
      clearTimeout(entry.timer);
      clearTimeout(entry.lifetime);
      entry.cancelQueued?.();
      for (const socket of entry.sockets) socket.destroy();
      entry.controller?.abort();
      // Hold the only process slot until a pending launch and actual shutdown finish.
      // Cancelling a control request must not admit a second, overlapping browser.
      await entry.setup?.catch(() => undefined);
      entry.proxy?.close();
      await entry.browser?.close().catch(() => undefined);
      sessions.delete(id);
      if (entry.reserved) active--;
      drain();
    });
    return entry.stopping;
  };
  const touch = (id, timeout = idleMs) => {
    const entry = sessions.get(id);
    if (!entry || entry.stopped) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void stop(id), timeout);
    entry.timer.unref();
  };
  const server = createServer(async (request, response) => {
    if (!authorized(request, token)) return jsonResponse(response, 401, { error: 'runtime_unauthorized' });
    if (request.method === 'GET' && ['/healthz', '/v1/manifest'].includes(request.url))
      return jsonResponse(response, 200, { ...manifest, status: 'ready', running: active, queued: waiting.length });
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
    if (closing || (active > 0 && waiting.length >= maxQueued))
      return jsonResponse(response, 503, { error: 'runtime_busy' });
    const id = randomUUID();
    const entry = { sockets: new Set(), browser: undefined, timer: undefined, lifetime: undefined };
    sessions.set(id, entry);
    const cancel = () => {
      if (!response.writableFinished) void stop(id);
    };
    response.once('close', cancel);
    try {
      await acquire(entry);
      if (entry.stopped || closing || response.destroyed) return;
      entry.setup = (async () => {
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
        if (entry.stopped || closing || response.destroyed) return;
        entry.browser = await launch(input.engine);
      })();
      await entry.setup;
      if (entry.stopped || closing || response.destroyed) {
        await stop(id);
        return;
      }
      entry.browser.on('close', () => void stop(id));
      touch(id, connectMs);
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
      if (!response.destroyed)
        jsonResponse(response, 503, {
          error: error.message === 'runtime_busy' ? 'runtime_busy' : 'source_browser_unavailable',
        });
    } finally {
      response.removeListener('close', cancel);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 65000;
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => undefined);
    const match = /^\/v1\/browsers\/([a-f0-9-]{36})\/ws$/.exec(request.url ?? '');
    const entry = match && sessions.get(match[1]);
    if (!authorized(request, token) || !entry?.browser || entry.stopped || entry.connected) {
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
      if (socket.destroyed || entry.stopped) {
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
