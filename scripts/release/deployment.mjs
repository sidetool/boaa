import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { access, chmod, chown, mkdir, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { atomicJson, readJson } from './files.mjs';
import { releaseVersion } from './feed.mjs';

const execute = promisify(execFile);
export const CORE = ['api', 'worker', 'web'];
export const COMPONENTS = { apk: 'runtime-apk', browser: 'runtime-browser', metadata: 'runtime-metadata' };
export const imageFor = (name) => (['api', 'worker'].includes(name) ? 'server' : name.replace('runtime-', ''));
const safeProject = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value);
export const dockerRun = async (args, timeout = 120000) => {
  try {
    return (await execute('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  } catch {
    throw new Error('deployment_command_failed');
  }
};

/** Persist the resolved operator configuration. Release metadata can change images, never mounts or commands. */
export function resolveInstallation(config, { project, hostDirectory }) {
  if (!safeProject(project) || !config?.services || !CORE.every((name) => config.services[name]))
    throw new Error('deployment_layout_unsupported');
  const result = structuredClone(config);
  result.name = project;
  const rewrite = (source) => (source && !path.isAbsolute(source) ? path.resolve(hostDirectory, source) : source);
  for (const service of Object.values(result.services)) {
    delete service.build;
    delete service.pull_policy;
    for (const mount of service.volumes ?? []) if (mount.type === 'bind') mount.source = rewrite(mount.source);
  }
  for (const entries of [result.secrets, result.configs])
    for (const entry of Object.values(entries ?? {})) if (entry.file) entry.file = rewrite(entry.file);
  return result;
}

// Compose interpolation also applies to resolved JSON. Preserve literal dollar signs in stored values.
export function escapeCompose(value) {
  if (typeof value === 'string') return value.replaceAll('$', () => '$$');
  if (Array.isArray(value)) return value.map(escapeCompose);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, escapeCompose(child)]));
  return value;
}

export function configuredBrowserEngine(config) {
  const env = config.services.api.environment ?? {};
  const runtime = config.services['runtime-browser']?.environment ?? {};
  const value =
    env.BOAA_BROWSER_ENGINE ||
    runtime.BOAA_BROWSER_ENGINE ||
    (env.BOAA_CAMOUFOX_EXECUTABLE || runtime.BOAA_CAMOUFOX_EXECUTABLE ? 'camoufox' : 'patchright');
  if (!['patchright', 'camoufox'].includes(value)) throw new Error('component_unsupported');
  return value;
}
export function browserImage(manifest, engine) {
  if (engine === 'patchright')
    return manifest?.images.browser?.engine === 'patchright' ? manifest.images.browser : undefined;
  return (
    manifest?.images['browser-camoufox'] ??
    (manifest?.images.browser?.engine !== 'patchright' ? manifest?.images.browser : undefined)
  );
}
export function componentConfiguration(config, id, enabled, engine = configuredBrowserEngine(config)) {
  const next = structuredClone(config);
  const environment = (next.services.api.environment ??= {});
  if (!next.services[COMPONENTS[id]]) throw new Error('component_unsupported');
  if (id === 'apk') {
    environment.BOAA_APK_RUNTIME_ENABLED = enabled ? '1' : '0';
  } else if (id === 'browser') {
    const existing = environment.BOAA_SOURCE_BROWSER_ENDPOINT;
    if (existing && existing !== 'http://runtime-browser:8791') throw new Error('component_external');
    environment.BOAA_SOURCE_BROWSER_ENDPOINT = enabled ? 'http://runtime-browser:8791' : '';
    environment.BOAA_BROWSER_ENGINE = engine;
    (next.services['runtime-browser'].environment ??= {}).BOAA_BROWSER_ENGINE = engine;
    if (next.services['runtime-metadata']) {
      (next.services['runtime-metadata'].environment ??= {}).BOAA_BROWSER_ENGINE = engine;
      next.services['runtime-metadata'].environment.BOAA_SOURCE_BROWSER_ENDPOINT = enabled
        ? 'http://runtime-browser:8791'
        : '';
    }
    if (environment.BOAA_MANAGED_METADATA_ENDPOINT)
      environment.WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED = enabled ? 'true' : 'false';
  } else if (id === 'metadata') {
    const existing = environment.WEBNOVEL_METADATA_COLLECTOR_URL;
    if (existing && existing !== 'http://runtime-metadata:8792') throw new Error('component_external');
    environment.WEBNOVEL_METADATA_COLLECTOR_URL = enabled ? 'http://runtime-metadata:8792' : '';
    environment.BOAA_MANAGED_METADATA_ENDPOINT = enabled ? 'http://runtime-metadata:8792' : '';
    environment.WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED =
      enabled && environment.BOAA_SOURCE_BROWSER_ENDPOINT === 'http://runtime-browser:8791' ? 'true' : 'false';
  }
  return next;
}

export class DockerDeployment {
  constructor({
    directory = '/state',
    installation = '/installation',
    run = dockerRun,
    platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
  } = {}) {
    this.directory = directory;
    this.installation = installation;
    this.run = run;
    this.platform = platform;
  }
  async initialize({ allowDrift = false } = {}) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.current = await readJson(path.join(this.directory, 'current.json'), null);
    if (this.current) {
      this.config = await readJson(this.current.config);
      this.project = this.current.project;
      if (!safeProject(this.project)) throw new Error('deployment_layout_unsupported');
      const journal = await readJson(path.join(this.directory, 'journal.json'), null);
      if (!allowDrift && (!journal || ['complete', 'rolled-back', 'cancelled'].includes(journal.phase)))
        await this.assertCurrentMatches();
      return;
    }
    if (process.env.BOAA_MANAGED_RELEASE !== '1' || !releaseVersion(process.env.BOAA_RELEASE_VERSION))
      throw new Error('deployment_unmanaged');
    const [self] = JSON.parse(await this.run(['inspect', process.env.HOSTNAME]));
    const labels = self?.Config?.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const hostDirectory = labels['com.docker.compose.project.working_dir'];
    if (!safeProject(project) || !path.isAbsolute(hostDirectory ?? ''))
      throw new Error('deployment_layout_unsupported');
    const originals = String(labels['com.docker.compose.project.config_files'] ?? '').split(',');
    const files = originals.map((file) => {
      const relative = path.relative(hostDirectory, file);
      if (!path.isAbsolute(file) || relative.startsWith('..') || !relative)
        throw new Error('deployment_layout_unsupported');
      return path.join(this.installation, relative);
    });
    const args = ['compose', '--project-name', project, '--project-directory', this.installation];
    if (
      await access(path.join(this.installation, '.env')).then(
        () => true,
        () => false,
      )
    )
      args.push('--env-file', path.join(this.installation, '.env'));
    for (const file of files) args.push('-f', file);
    args.push('--profile', '*', 'config', '--no-path-resolution', '--format', 'json');
    this.config = resolveInstallation(JSON.parse(await this.run(args)), {
      project,
      hostDirectory,
      installation: this.installation,
    });
    if (!CORE.every((name) => /@sha256:[a-f0-9]{64}$/.test(this.config.services[name].image)))
      throw new Error('deployment_unmanaged');
    this.assertBackupLayout();
    this.project = project;
    this.current = {
      project,
      version: process.env.BOAA_RELEASE_VERSION,
      schemaEpoch: Number(process.env.BOAA_RELEASE_SCHEMA_EPOCH || '1'),
      enabled: Object.keys(COMPONENTS).filter((id) => {
        const env = this.config.services.api.environment;
        return id === 'apk'
          ? env.BOAA_APK_RUNTIME_ENABLED === '1'
          : id === 'browser'
            ? env.BOAA_SOURCE_BROWSER_ENDPOINT === 'http://runtime-browser:8791'
            : env.BOAA_MANAGED_METADATA_ENDPOINT === 'http://runtime-metadata:8792';
      }),
      installed: [],
      config: path.join(this.directory, 'initial.config.json'),
      compose: path.join(this.directory, 'initial.compose.json'),
    };
    // Components enabled by the initial installer are already installed. Retain
    // that fact when the owner later stops them without downloading anything.
    this.current.installed = [...this.current.enabled];
    this.current.componentVersions = Object.fromEntries(this.current.enabled.map((id) => [id, this.current.version]));
    if (this.current.enabled.includes('browser')) {
      this.current.browserEngine = configuredBrowserEngine(this.config);
      this.current.installedBrowserEngines = [this.current.browserEngine];
      this.current.browserVersions = { [this.current.browserEngine]: this.current.version };
    }
    await atomicJson(this.current.config, this.config);
    await atomicJson(this.current.compose, escapeCompose(this.config));
    await atomicJson(path.join(this.directory, 'current.json'), this.current);
  }
  compose(file, args, timeout) {
    return this.run(['compose', '--project-name', this.project, '-f', file, ...args], timeout);
  }
  async stage(config, state, id) {
    const directory = path.join(this.directory, 'deployments', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const next = {
      ...state,
      config: path.join(directory, 'config.json'),
      compose: path.join(directory, 'compose.json'),
    };
    await atomicJson(next.config, config);
    await atomicJson(next.compose, escapeCompose(config));
    return next;
  }
  async pull(config, services) {
    for (const image of new Set(services.map((name) => config.services[name].image)))
      await this.run(['pull', '--platform', this.platform, image], 20 * 60_000);
  }
  async stop(state) {
    await this.compose(state.compose, ['stop', '--timeout', '120', 'worker', 'api'], 180_000);
    const helpers = state.enabled.filter((id) => id !== 'apk').map((id) => COMPONENTS[id]);
    if (helpers.length) await this.compose(state.compose, ['stop', '--timeout', '30', ...helpers], 90_000);
  }
  assertBackupLayout() {
    const postgres = this.config.services.postgres?.environment;
    if (!postgres) throw new Error('deployment_layout_unsupported');
    for (const service of ['api', 'worker']) {
      const env = this.config.services[service].environment || {};
      if (env.SERVER_DATA_DIR !== '/data/server') throw new Error('deployment_layout_unsupported');
      let host = env.PGHOST,
        port = String(env.PGPORT || '5432'),
        database = env.PGDATABASE,
        user = env.PGUSER,
        password = env.PGPASSWORD;
      if (env.DATABASE_URL?.trim()) {
        let url;
        try {
          url = new URL(env.DATABASE_URL);
        } catch {
          throw new Error('deployment_layout_unsupported');
        }
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash)
          throw new Error('deployment_layout_unsupported');
        host = url.hostname;
        port = url.port || '5432';
        database = decodeURIComponent(url.pathname.slice(1));
        user = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
      }
      if (
        host !== 'postgres' ||
        port !== '5432' ||
        database !== postgres.POSTGRES_DB ||
        user !== postgres.POSTGRES_USER ||
        password !== postgres.POSTGRES_PASSWORD
      )
        throw new Error('deployment_layout_unsupported');
    }
  }
  async backup(state, id) {
    this.assertBackupLayout();
    const space = await statfs(this.directory);
    if (space.bavail * space.bsize < 1024 ** 3) throw new Error('update_space_required');
    const folder = path.join(this.directory, 'backups', id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const args = [
      'compose',
      '--project-name',
      this.project,
      '-f',
      state.compose,
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'exec pg_dump --format=custom --no-owner -U "$POSTGRES_USER" "$POSTGRES_DB"',
    ];
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('update_backup_failed'))));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60_000);
    try {
      await Promise.all([
        pipeline(child.stdout, createWriteStream(path.join(folder, 'database.dump'), { flags: 'wx', mode: 0o600 })),
        finished,
      ]);
    } catch {
      child.kill('SIGKILL');
      throw new Error('update_backup_failed');
    } finally {
      clearTimeout(timer);
    }
    await this.compose(state.compose, ['cp', 'api:/data/server/.', path.join(folder, 'server')], 20 * 60_000);
    if (state.enabled.includes('metadata'))
      await this.compose(state.compose, ['cp', 'runtime-metadata:/data/.', path.join(folder, 'metadata')], 20 * 60_000);
    await atomicJson(path.join(folder, 'deployment.json'), state);
    // Original objects stay in their existing volume. This is a DB/settings recovery point, not a media export.
  }
  async apply(state) {
    if (state.enabled.includes('apk')) {
      await this.compose(
        state.compose,
        ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', 'runtime-apk'],
        120_000,
      );
      const container = await this.compose(state.compose, ['ps', '-aq', 'runtime-apk']);
      if (!container || !/^\d+$/.test(await this.run(['wait', container], 10 * 60_000)))
        throw new Error('component_start_failed');
      const [inspection] = JSON.parse(await this.run(['inspect', container]));
      if (inspection.State.ExitCode !== 0) throw new Error('component_start_failed');
    }
    const helpers = state.enabled.filter((id) => id !== 'apk').map((id) => COMPONENTS[id]);
    if (helpers.length)
      await this.compose(
        state.compose,
        ['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '120', ...helpers],
        180_000,
      );
    await this.compose(
      state.compose,
      ['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '120', 'api', 'worker', 'web'],
      180_000,
    );
    for (const id of Object.keys(COMPONENTS).filter((id) => !state.enabled.includes(id)))
      await this.compose(state.compose, ['stop', '--timeout', '30', COMPONENTS[id]], 60_000);
  }
  async verify(state) {
    const config = await readJson(state.config);
    for (const name of [...CORE, ...state.enabled.map((id) => COMPONENTS[id])]) {
      const container = await this.compose(state.compose, ['ps', '-aq', name]);
      if (!container || container.includes('\n')) throw new Error('update_health_failed');
      const [actual] = JSON.parse(await this.run(['inspect', container]));
      if (actual.Config.Image !== config.services[name].image) throw new Error('update_health_failed');
      if (
        name === 'runtime-apk'
          ? actual.State.Status !== 'exited' || actual.State.ExitCode !== 0
          : actual.State.Status !== 'running' || (actual.State.Health && actual.State.Health.Status !== 'healthy')
      )
        throw new Error('update_health_failed');
    }
    await this.compose(
      state.compose,
      [
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "(async()=>{for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:8787/ready',{signal:AbortSignal.timeout(3000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,2000));}process.exitCode=1;})().catch(()=>process.exitCode=1)",
      ],
      180_000,
    );
  }
  async assertCurrentMatches() {
    this.assertBackupLayout();
    const names = [...CORE, ...this.current.enabled.map((id) => COMPONENTS[id]), 'postgres', 'redis', 'minio'];
    const containers = (await this.compose(this.current.compose, ['ps', '-aq', ...names])).split('\n').filter(Boolean);
    if (containers.length !== names.length) throw new Error('deployment_drift');
    const inspected = JSON.parse(await this.run(['inspect', ...containers]));
    for (const name of names) {
      const matches = inspected.filter((actual) => actual.Config.Labels?.['com.docker.compose.service'] === name);
      if (matches.length !== 1) throw new Error('deployment_drift');
      const actual = matches[0];
      const expected = this.config.services[name];
      if (actual.Config.Image !== expected.image) throw new Error('deployment_drift');
      const environment = Object.fromEntries(
        (actual.Config.Env || []).map((entry) => {
          const split = entry.indexOf('=');
          return [entry.slice(0, split), entry.slice(split + 1)];
        }),
      );
      for (const [key, value] of Object.entries(expected.environment || {}))
        if (value !== null && environment[key] !== String(value)) throw new Error('deployment_drift');
      for (const volume of expected.volumes || []) {
        const mount = actual.Mounts?.find((mount) => mount.Destination === volume.target);
        const source = volume.type === 'volume' ? this.config.volumes?.[volume.source]?.name : volume.source;
        if (
          !mount ||
          mount.Type !== volume.type ||
          (source && (volume.type === 'volume' ? mount.Name : mount.Source) !== source) ||
          Boolean(volume.read_only) === Boolean(mount.RW)
        )
          throw new Error('deployment_drift');
      }
    }
  }
  async componentHealth(id) {
    const container = await this.compose(this.current.compose, ['ps', '-aq', COMPONENTS[id]]);
    if (!container || container.includes('\n')) return { running: false, error: 'component_unavailable' };
    const [actual] = JSON.parse(await this.run(['inspect', container]));
    const running =
      id === 'apk'
        ? actual.State.Status === 'exited' && actual.State.ExitCode === 0
        : actual.State.Status === 'running' && (!actual.State.Health || actual.State.Health.Status === 'healthy');
    if (!running) return { running: false, error: 'component_unavailable' };
    if (id === 'metadata') {
      const probe =
        'import json,urllib.request; from metadata_runner import read_token; r=urllib.request.Request("http://127.0.0.1:8792/healthz",headers={"Authorization":"Bearer "+read_token()}); print(json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=3)).get("providerStatus","missing"))';
      const provider = await this.run(['exec', container, 'python', '-c', probe], 10000);
      if (provider !== 'ready') return { running: true, error: 'component_provider_missing' };
    }
    return { running: true };
  }
  async commit(state) {
    await atomicJson(path.join(this.directory, 'current.json'), state);
    this.current = state;
    this.config = await readJson(state.config);
  }
}

export async function prepareMailbox(directory) {
  await mkdir(directory, { recursive: true, mode: 0o2770 });
  if (process.getuid?.() === 0) await chown(directory, 1000, 1000);
  await chmod(directory, 0o2770);
}
