import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresHarnessLifetime } from './postgres-harness-lifetime.js';

export interface PostgresIntegrationHarness {
  readonly source: string;
  readonly url: string;
  stop(): Promise<void>;
}

// Owned shutdown commands have a 30-second deadline; allow schema cleanup too.
export const POSTGRES_HARNESS_CLEANUP_TIMEOUT_MS = 45_000;

const lifetimes = new WeakMap<PostgresIntegrationHarness, PostgresHarnessLifetime>();

function manageHarness(harness: PostgresIntegrationHarness): PostgresIntegrationHarness {
  const lifetime = new PostgresHarnessLifetime();
  const managed = { ...harness, stop: () => lifetime.stop(() => harness.stop()) };
  lifetimes.set(managed, lifetime);
  return managed;
}

const TEMP_DIRECTORY_REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 100 } as const;

function runProcess(
  command: string,
  args: readonly string[],
  timeout = 60_000,
  ignoreOutput = false,
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ignoreOutput ? 'ignore' : 'pipe',
    timeout,
    windowsHide: true,
  });
}

function requireProcess(
  label: string,
  command: string,
  args: readonly string[],
  timeout?: number,
  ignoreOutput = false,
): void {
  const result = runProcess(command, args, timeout, ignoreOutput);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a PostgreSQL test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function hasPostgresExecutables(directory: string): Promise<boolean> {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  try {
    await Promise.all(['initdb', 'pg_ctl', 'postgres'].map((name) => access(path.join(directory, `${name}${suffix}`))));
    return true;
  } catch {
    return false;
  }
}

function executableDirectoryFromPath(name: string): string | undefined {
  const result = runProcess(process.platform === 'win32' ? 'where.exe' : 'which', [name], 5_000);
  const first = result.status === 0 ? String(result.stdout).split(/\r?\n/).find(Boolean) : undefined;
  return first ? path.dirname(first.trim()) : undefined;
}

async function findPostgresBin(): Promise<string | undefined> {
  const candidates = [process.env.POSTGRES_BIN_DIR, executableDirectoryFromPath('initdb')].filter(
    (entry): entry is string => Boolean(entry),
  );
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    const root = path.join(process.env.ProgramFiles, 'PostgreSQL');
    try {
      const versions = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      candidates.push(...versions.map((version) => path.join(root, version, 'bin')));
    } catch {
      // A standard PostgreSQL installation is optional.
    }
  }
  for (const candidate of candidates) {
    if (await hasPostgresExecutables(candidate)) return candidate;
  }
  return undefined;
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 1_000, max: 1 });
    try {
      await pool.query('select 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error('Temporary PostgreSQL did not become ready.');
}

async function startLocalPostgres(bin: string): Promise<PostgresIntegrationHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'boaa-id-v2-pg-'));
  const data = path.join(root, 'data');
  const log = path.join(root, 'postgres.log');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executable = (name: string) => path.join(bin, `${name}${suffix}`);
  const port = await unusedPort();
  try {
    requireProcess('initdb', executable('initdb'), [
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'postgres',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    requireProcess(
      'pg_ctl start',
      executable('pg_ctl'),
      ['-D', data, '-l', log, '-o', `-F -p ${port} -h 127.0.0.1`, '-w', 'start'],
      45_000,
      true,
    );
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url);
    return {
      source: `local:${bin}`,
      url,
      async stop() {
        runProcess(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], 30_000, true);
        await rm(root, TEMP_DIRECTORY_REMOVE_OPTIONS);
      },
    };
  } catch (error) {
    runProcess(executable('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], 10_000, true);
    await rm(root, TEMP_DIRECTORY_REMOVE_OPTIONS);
    throw error;
  }
}

async function startDockerPostgres(): Promise<PostgresIntegrationHarness | undefined> {
  if (runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], 10_000).status !== 0) return undefined;
  const port = await unusedPort();
  const container = `boaa-id-v2-${randomUUID().slice(0, 8)}`;
  requireProcess(
    'docker postgres start',
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      container,
      '--env',
      'POSTGRES_PASSWORD=boaa_test',
      '--publish',
      `127.0.0.1:${port}:5432`,
      'postgres:16-alpine',
      // Match the local ephemeral harness (-F). These tests verify transactions,
      // not crash durability; fsync per migration otherwise dominates parallel runs.
      'postgres',
      '-F',
    ],
    120_000,
  );
  const url = `postgres://postgres:boaa_test@127.0.0.1:${port}/postgres`;
  await waitForPostgres(url);
  return {
    source: `docker:${container}`,
    url,
    async stop() {
      runProcess('docker', ['rm', '--force', container], 30_000, true);
    },
  };
}

export async function startPostgresIntegrationHarness(): Promise<PostgresIntegrationHarness | undefined> {
  const external =
    process.env.BOAA_TEST_DATABASE_URL ??
    process.env.MOYA_TEST_DATABASE_URL ??
    process.env.NOVELDESK_TEST_DATABASE_URL ??
    process.env.MOA_TEST_DATABASE_URL ??
    process.env.POSTGRES_TEST_URL;
  if (external) {
    await waitForPostgres(external);
    return manageHarness({ source: 'environment', url: external, async stop() {} });
  }
  const bin = await findPostgresBin();
  const harness = bin ? await startLocalPostgres(bin) : await startDockerPostgres();
  return harness ? manageHarness(harness) : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function withPostgresSchema<T>(
  harness: PostgresIntegrationHarness,
  label: string,
  callback: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const run = () => runPostgresSchema(harness, label, callback);
  return lifetimes.get(harness)?.run(run) ?? run();
}

async function runPostgresSchema<T>(
  harness: PostgresIntegrationHarness,
  label: string,
  callback: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const schema = `${label}_${randomUUID().replaceAll('-', '')}`.toLowerCase();
  const admin = new pg.Pool({ connectionString: harness.url, max: 2 });
  await admin.query(`create schema ${quoteIdentifier(schema)}`);
  const url = new URL(harness.url);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  try {
    return await callback(pool);
  } finally {
    try {
      await pool.end();
      await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    } finally {
      await admin.end();
    }
  }
}
