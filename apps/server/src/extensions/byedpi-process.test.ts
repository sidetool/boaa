import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkByeDpiSocks, createByeDpiProcess, type ByeDpiProcess } from './byedpi-process.js';

const roots: string[] = [];
const managers: ByeDpiProcess[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function eventually(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('fixture_timeout');
}
async function fixture(mode = 'healthy') {
  const root = await mkdtemp(join(tmpdir(), 'boaa-byedpi-fixture-'));
  roots.push(root);
  const binary = join(root, 'socks-fixture');
  const pid = join(root, 'pid');
  await writeFile(
    binary,
    `#!${process.execPath}
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), value = (key) => args[args.indexOf(key) + 1];
let healthy = '${mode}' === 'healthy';
process.on('SIGUSR2', () => { healthy = false; });
writeFileSync(value('--fixture-pid'), String(process.pid));
const server = createServer(socket => {
  socket.on('error', () => {});
  socket.once('data', bytes => {
    if (bytes[0] !== 5 || bytes[1] !== 1 || bytes[2] !== 0) process.exit(42);
    if ('${mode}' === 'hang') return;
    socket.write(Buffer.from([5]));
    setTimeout(() => socket.end(Buffer.from([healthy ? 0 : 255])), 5);
  });
});
server.listen(Number(value('--port')), value('--ip'));
`,
    { mode: 0o700 },
  );
  const manager = createByeDpiProcess({
    binaryPath: binary,
    host: '127.0.0.1',
    port: await unusedPort(),
    args: ['--fixture-pid', pid],
    startupTimeoutMs: mode === 'healthy' ? 2000 : 250,
    retryDelayMs: 100,
    healthIntervalMs: 30,
    stopTimeoutMs: 100,
  });
  managers.push(manager);
  return { manager, pid: async () => Number(await readFile(pid, 'utf8')) };
}
it('owns a real child, coalesces start, negotiates fragmented SOCKS5 and reaps it on stop', async () => {
  const { manager, pid } = await fixture();
  expect(manager.status()).toEqual({ available: true, running: false });
  await Promise.all([manager.ensureRunning(), manager.ensureRunning()]);
  expect(manager.status().running).toBe(true);
  const child = await pid();
  process.kill(child, 0);
  await manager.stop();
  expect(manager.status().running).toBe(false);
  expect(() => process.kill(child, 0)).toThrow();
  await delay(150);
  expect(manager.status().running).toBe(false);
});
it('reports an interrupted child and restarts it without changing the advertised URL', async () => {
  const { manager, pid } = await fixture();
  await manager.ensureRunning();
  const child = await pid(),
    proxy = manager.proxyUrl;
  process.kill(child, 'SIGKILL');
  await eventually(() => !manager.status().running);
  await eventually(async () => manager.status().running && (await pid()) !== child);
  expect(manager.proxyUrl).toBe(proxy);
});
it('detects unhealthy SOCKS on a still-live child and restarts the owned process', async () => {
  const { manager, pid } = await fixture();
  await manager.ensureRunning();
  const child = await pid();
  process.kill(child, 'SIGUSR2');
  await eventually(() => !manager.status().running);
  await eventually(async () => manager.status().running && (await pid()) !== child);
});
it.each(['reject', 'hang'])('rejects %s SOCKS health and reaps the failed child', async (mode) => {
  const { manager, pid } = await fixture(mode);
  await expect(manager.ensureRunning()).rejects.toThrow('byedpi_start_failed');
  expect(manager.status().running).toBe(false);
  const child = await pid();
  await manager.stop();
  expect(() => process.kill(child, 0)).toThrow();
});
it('cancels startup and does not adopt another listener or a missing executable', async () => {
  const { manager } = await fixture('hang');
  const starting = manager.ensureRunning();
  const failure = expect(starting).rejects.toThrow('byedpi_start_failed');
  await delay(30);
  await manager.stop();
  await failure;
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.end(Buffer.from([5, 0]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const occupied = createByeDpiProcess({
    binaryPath: process.execPath,
    port: (server.address() as { port: number }).port,
    args: [],
  });
  managers.push(occupied);
  try {
    await expect(occupied.ensureRunning()).rejects.toThrow('byedpi_start_failed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const missing = createByeDpiProcess({ binaryPath: '/missing/boaa-fixture', args: [] });
  managers.push(missing);
  expect(missing.status().available).toBe(false);
  await expect(missing.ensureRunning()).rejects.toThrow('byedpi_unavailable');
});
it('bounds standalone SOCKS health and rejects options that detach the process', async () => {
  await expect(checkByeDpiSocks('127.0.0.1', await unusedPort(), undefined, 30)).rejects.toThrow(
    'byedpi_health_failed',
  );
  for (const args of [['--daemon'], ['-D'], ['--ip=0.0.0.0'], ['--debug', '1']])
    expect(() => createByeDpiProcess({ args })).toThrow('byedpi_configuration_invalid');
});
