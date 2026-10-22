import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerDeployment, resolveInstallation } from './deployment.mjs';
import { atomicJson } from './files.mjs';

function fixture() {
  const environment = {
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'books',
    PGUSER: 'reader',
    PGPASSWORD: 'fixture-secret',
    SERVER_DATA_DIR: '/data/server',
  };
  const config = {
    services: {
      api: {
        image: 'server@sha256:old',
        environment,
        volumes: [{ type: 'volume', source: 'data', target: '/data/server' }],
      },
      worker: { image: 'server@sha256:old', environment: { ...environment } },
      web: { image: 'web@sha256:old' },
      postgres: {
        image: 'postgres:fixture',
        environment: { POSTGRES_USER: 'reader', POSTGRES_PASSWORD: 'fixture-secret', POSTGRES_DB: 'books' },
      },
      redis: { image: 'redis:fixture' },
      minio: { image: 'minio:fixture' },
    },
    volumes: { data: { name: 'fixture_data' } },
  };
  const actual = Object.entries(config.services).map(([name, service]) => ({
    Config: {
      Image: service.image,
      Labels: { 'com.docker.compose.service': name },
      Env: Object.entries(service.environment || {}).map(([key, value]) => `${key}=${value}`),
    },
    Mounts: name === 'api' ? [{ Type: 'volume', Name: 'fixture_data', Destination: '/data/server', RW: true }] : [],
  }));
  const deployment = new DockerDeployment({
    run: async (args) =>
      args[0] === 'inspect' ? JSON.stringify(actual) : actual.map((_, index) => `container${index}`).join('\n'),
  });
  deployment.config = config;
  deployment.current = { project: 'fixture', enabled: [], compose: 'current.json' };
  deployment.project = 'fixture';
  return { deployment, config, actual };
}
test('relative and parent bind paths resolve against the operator installation directory', () => {
  const config = {
    services: {
      api: {
        volumes: [
          { type: 'bind', source: '../keys', target: '/keys' },
          { type: 'bind', source: '/external/data', target: '/data' },
        ],
      },
      worker: {},
      web: {},
    },
  };
  const resolved = resolveInstallation(config, { project: 'fixture', hostDirectory: '/srv/boaa' });
  assert.deepEqual(
    resolved.services.api.volumes.map((v) => v.source),
    ['/srv/keys', '/external/data'],
  );
});
test('backup preflight rejects external databases, mismatched credentials and unbacked data directories', () => {
  for (const change of [
    (env) => (env.DATABASE_URL = 'postgres://reader:fixture-secret@elsewhere/books'),
    (env) => (env.PGDATABASE = 'other'),
    (env) => (env.SERVER_DATA_DIR = '/unbacked'),
  ]) {
    const f = fixture();
    change(f.config.services.api.environment);
    assert.throws(() => f.deployment.assertBackupLayout(), /deployment_layout_unsupported/);
  }
  const f = fixture();
  f.config.services.api.environment.DATABASE_URL = 'postgresql://reader:fixture-secret@postgres:5432/books';
  assert.doesNotThrow(() => f.deployment.assertBackupLayout());
});
test('live image, environment and storage drift prevent managed changes', async () => {
  await fixture().deployment.assertCurrentMatches();
  for (const change of [
    (actual) => (actual.Config.Image = 'old-bootstrap-image'),
    (actual) => actual.Config.Env.push('PGDATABASE=other'),
    (actual) => (actual.Mounts[0].Name = 'other-volume'),
  ]) {
    const f = fixture();
    change(f.actual[0]);
    await assert.rejects(f.deployment.assertCurrentMatches(), /deployment_drift/);
  }
});
test('an interrupted journal reaches recovery instead of failing early on expected image differences', async (t) => {
  const f = fixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-drift-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  f.deployment.directory = directory;
  await atomicJson(path.join(directory, 'config.json'), f.config);
  await atomicJson(path.join(directory, 'current.json'), {
    ...f.deployment.current,
    config: path.join(directory, 'config.json'),
  });
  f.actual[0].Config.Image = 'partially-applied-target';
  await atomicJson(path.join(directory, 'journal.json'), { phase: 'applying' });
  await f.deployment.initialize();
  await atomicJson(path.join(directory, 'journal.json'), { phase: 'complete' });
  await assert.rejects(f.deployment.initialize(), /deployment_drift/);
});

test('initial enabled Patchright is recorded as installed and existing managed state is not re-defaulted', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boaa-default-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ['BOAA_MANAGED_RELEASE', 'BOAA_RELEASE_VERSION', 'BOAA_RELEASE_SCHEMA_EPOCH'];
  const previous = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }),
  );
  process.env.BOAA_MANAGED_RELEASE = '1';
  process.env.BOAA_RELEASE_VERSION = '1.0.0';
  process.env.BOAA_RELEASE_SCHEMA_EPOCH = '2';
  const config = fixture().config;
  for (const service of ['api', 'worker', 'web']) config.services[service].image = `fixture@sha256:${'a'.repeat(64)}`;
  config.services.api.environment.BOAA_SOURCE_BROWSER_ENDPOINT = 'http://runtime-browser:8791';
  config.services.api.environment.BOAA_BROWSER_ENGINE = 'patchright';
  config.services['runtime-browser'] = { image: `browser@sha256:${'b'.repeat(64)}` };
  const deployment = new DockerDeployment({
    directory,
    installation: directory,
    run: async (args) => {
      if (args[0] === 'inspect')
        return JSON.stringify([
          {
            Config: {
              Labels: {
                'com.docker.compose.project': 'fixture',
                'com.docker.compose.project.working_dir': directory,
                'com.docker.compose.project.config_files': path.join(directory, 'compose.release.yaml'),
              },
            },
          },
        ]);
      return JSON.stringify(config);
    },
  });
  await deployment.initialize();
  assert.deepEqual(deployment.current.enabled, ['browser']);
  assert.deepEqual(deployment.current.installed, ['browser']);
  assert.deepEqual(deployment.current.installedBrowserEngines, ['patchright']);
  assert.equal(deployment.current.componentVersions.browser, '1.0.0');
  const stopped = { ...deployment.current, enabled: [] };
  await atomicJson(path.join(directory, 'current.json'), stopped);
  await deployment.initialize({ allowDrift: true });
  assert.deepEqual(deployment.current, stopped);
});
