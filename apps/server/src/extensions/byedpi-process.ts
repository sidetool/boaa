import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { connect, isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOutboundProxy } from './outbound-proxy.js';

export interface ByeDpiProcess {
  readonly proxyUrl: string;
  status(): { available: boolean; running: boolean };
  ensureRunning(): Promise<void>;
  stop(): Promise<void>;
}
export interface ByeDpiProcessOptions {
  binaryPath?: string;
  host?: string;
  port?: number;
  proxyUrl?: string;
  args?: string[];
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  retryDelayMs?: number;
  stopTimeoutMs?: number;
}

/** SOCKS5 method negotiation only: health checks never contact a content source. */
export async function checkByeDpiSocks(host: string, port: number, signal?: AbortSignal, timeoutMs = 500) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    let received = Buffer.alloc(0);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error('byedpi_start_cancelled'));
    const timer = setTimeout(() => finish(new Error('byedpi_health_failed')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (bytes: Buffer) => {
      received = Buffer.concat([received, bytes]);
      if (received.length >= 2)
        finish(received[0] === 5 && received[1] === 0 ? undefined : new Error('byedpi_health_failed'));
    });
    socket.once('error', () => finish(new Error('byedpi_health_failed')));
    socket.once('end', () => finish(new Error('byedpi_health_failed')));
    if (signal?.aborted) abort();
  });
}

/** Host-owned, foreground process. No shell, source arguments, request logs or inherited secrets. */
export function createByeDpiProcess(options: ByeDpiProcessOptions = {}): ByeDpiProcess {
  const binary = options.binaryPath ?? process.env.BYEDPI_BINARY ?? '/usr/local/bin/byedpi';
  const host = options.host ?? process.env.BYEDPI_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.BYEDPI_PORT ?? 1080);
  const proxyUrl = parseOutboundProxy(options.proxyUrl ?? process.env.BYEDPI_PROXY_URL ?? `socks5://127.0.0.1:${port}`);
  let args: unknown = options.args;
  if (!args) {
    try {
      args = process.env.BYEDPI_ARGS_JSON
        ? JSON.parse(process.env.BYEDPI_ARGS_JSON)
        : ['--disorder', '1', '--auto', 'torst', '--tlsrec', '1+s', '--no-udp'];
    } catch {
      throw new Error('byedpi_configuration_invalid');
    }
  }
  if (
    !isAbsolute(binary) ||
    !isIP(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !proxyUrl?.startsWith('socks5:') ||
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.length > 2048 ||
        Array.from(arg).some((character) => [0, 10, 13].includes(character.charCodeAt(0))) ||
        /^(?:--(?:daemon|ip|port|pidfile|transparent|debug|cache-dump)(?:=|$)|-[DwipExy])/.test(arg),
    )
  )
    throw new Error('byedpi_configuration_invalid');
  const processArgs = ['--ip', host, '--port', String(port), ...(args as string[])];
  const healthHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const startupTimeoutMs = options.startupTimeoutMs ?? 8000;
  const healthIntervalMs = options.healthIntervalMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 2000;
  let child: ChildProcess | undefined;
  let desired = false;
  let running = false;
  let starting: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setTimeout> | undefined;
  let stopping = Promise.resolve();
  let failures = 0;
  const available = () => {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const terminate = async () => {
    const active = child;
    child = undefined;
    running = false;
    if (!active) return stopping;
    const terminated = new Promise<void>((resolve) => {
      const timer = setTimeout(() => active.kill('SIGKILL'), stopTimeoutMs);
      active.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      active.kill('SIGTERM');
    });
    stopping = Promise.all([stopping, terminated]).then(() => {});
    await stopping;
  };
  const scheduleRetry = () => {
    if (!desired || retry) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        void ensureRunning().catch(() => {});
      },
      Math.min(retryDelayMs * 2 ** Math.min(failures++, 5), 30000),
    );
    retry.unref();
  };
  const watch = () => {
    clearTimeout(monitor);
    if (!desired || !running) return;
    const active = child;
    monitor = setTimeout(() => {
      void (async () => {
        try {
          await checkByeDpiSocks(healthHost, port);
          if (child === active) watch();
        } catch {
          if (child === active) {
            await terminate();
            scheduleRetry();
          }
        }
      })();
    }, healthIntervalMs);
    monitor.unref();
  };
  const ensureRunning = (): Promise<void> => {
    desired = true;
    if (starting) return starting;
    clearTimeout(retry);
    retry = undefined;
    controller = new AbortController();
    const signal = controller.signal;
    starting = (async () => {
      if (running && child) {
        try {
          await checkByeDpiSocks(healthHost, port, signal);
          return;
        } catch {
          await terminate();
        }
      }
      if (!available()) throw new Error('byedpi_unavailable');
      signal.throwIfAborted();
      // Refuse an already listening service instead of treating it as our managed process.
      const occupied = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: healthHost, port });
        const finish = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(500, () => finish(true));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });
      if (occupied) throw new Error('byedpi_start_failed');
      signal.throwIfAborted();
      const active = spawn(binary, processArgs, { env: {}, stdio: 'ignore', windowsHide: true });
      child = active;
      let exited = false;
      active.once('error', () => {
        exited = true;
      });
      active.once('close', () => {
        exited = true;
        if (child === active) {
          child = undefined;
          running = false;
          scheduleRetry();
        }
      });
      const deadline = Date.now() + startupTimeoutMs;
      while (!exited && Date.now() < deadline) {
        signal.throwIfAborted();
        try {
          await checkByeDpiSocks(healthHost, port, signal, Math.min(500, Math.max(1, deadline - Date.now())));
          await delay(25, undefined, { signal });
          if (!exited && child === active && desired) {
            running = true;
            failures = 0;
            watch();
            return;
          }
        } catch {
          signal.throwIfAborted();
        }
        await delay(50, undefined, { signal });
      }
      throw new Error('byedpi_start_failed');
    })()
      .catch(async (error: unknown) => {
        await terminate();
        scheduleRetry();
        if (error instanceof Error && error.message === 'byedpi_unavailable') throw error;
        throw new Error('byedpi_start_failed');
      })
      .finally(() => {
        starting = undefined;
        controller = undefined;
      });
    return starting;
  };
  return {
    proxyUrl,
    status: () => ({ available: available(), running }),
    ensureRunning,
    async stop() {
      desired = false;
      clearTimeout(retry);
      clearTimeout(monitor);
      retry = undefined;
      controller?.abort();
      await starting?.catch(() => {});
      await terminate();
    },
  };
}
