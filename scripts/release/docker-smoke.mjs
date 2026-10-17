// Opt-in integration test: real API/worker/PostgreSQL/Redis/MinIO and optional runtimes,
// isolated volumes/network, final images and a fixture release feed. No registry publication.
// Run inside the final updater image with /var/run/docker.sock and /tmp mounted at the same paths.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerDeployment, dockerRun, imageFor, prepareMailbox } from './deployment.mjs';
import { ServerUpdater } from './updater.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'boaa-managed-smoke-'));
const project = `boaa-managed-smoke-${randomUUID().slice(0, 8)}`;
const network = `${project}-network`;
const images = {
  server: process.env.BOAA_SMOKE_SERVER_IMAGE || 'boaa-server-runtime-check:local',
  web: process.env.BOAA_SMOKE_WEB_IMAGE || 'boaa-web:release-check',
  apk: process.env.BOAA_SMOKE_APK_IMAGE || 'boaa-runtime-apk:local-check',
  browser: process.env.BOAA_SMOKE_BROWSER_IMAGE || 'boaa-runtime-browser:local-check',
  metadata: process.env.BOAA_SMOKE_METADATA_IMAGE || 'boaa-runtime-metadata:local-check',
};
let updater, heartbeat, current;
const health = (test) => ({ test, interval: '2s', timeout: '5s', retries: 30, start_period: '5s' });
class LocalDeployment extends DockerDeployment {
  async pull(config, services) {
    // Signature/feed tests cover acquisition. Here exercise the deployment with already built local images.
    for (const service of services) {
      config.services[service].image = images[imageFor(service)];
      await this.run(['image', 'inspect', config.services[service].image]);
    }
  }
  async stage(config, state, id) {
    const next = structuredClone(config);
    // Force a genuine address change; normal Docker allocation often reuses the same address.
    const address = next.services.api.networks.default.ipv4_address;
    next.services.api.networks.default.ipv4_address = address.endsWith('.230')
      ? address.replace(/230$/, '231')
      : address.replace(/231$/, '230');
    if (state.version === '1.2.0') next.services.worker.command = ['node', '-e', 'process.exit(23)'];
    return super.stage(next, state, id);
  }
}
const deployment = new LocalDeployment({ directory: path.join(root, 'state') });
deployment.project = project;
async function apiRequest(method, route, body) {
  // Exercise the actual nginx ingress as well as auth and routes. Maintenance is sampled by the API
  // once a second, so wait only for that explicit response after an operation releases its lease.
  const program = `(async()=>{for(let attempt=0;attempt<20;attempt++){
    const r=await fetch('http://web'+${JSON.stringify(route)},{method:${JSON.stringify(method)},signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+process.env.READER_AUTH_TOKEN,'Content-Type':'application/json'},${body ? `body:JSON.stringify(${JSON.stringify(body)}),` : ''}});
    const body=await r.json();
    if(r.status===503&&body.error==='server_maintenance'){await new Promise(resolve=>setTimeout(resolve,500));continue;}
    console.log(JSON.stringify({status:r.status,body,maintenanceRetries:attempt}));return;
  }console.log(JSON.stringify({status:503,body:{error:'maintenance_did_not_clear'}}));})().catch(e=>console.log(JSON.stringify({status:0,error:e.message})))`;
  const result = JSON.parse(
    await deployment.compose(deployment.current.compose, ['exec', '-T', 'api', 'node', '-e', program]),
  );
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${route}: ${JSON.stringify(result)}`);
  if (result.maintenanceRetries)
    console.log(`PASS maintenance released after ${result.maintenanceRetries} bounded polls`);
  return result.body;
}
async function healthyWeb() {
  assert.equal(
    await deployment
      .compose(deployment.current.compose, ['exec', '-T', 'web', 'wget', '-qO-', 'http://127.0.0.1/health'])
      .then((body) => JSON.parse(body).ok),
    true,
  );
}
async function request(action) {
  await updater.publish();
  const accepted = await apiRequest('POST', '/api/admin/system/requests', action);
  assert.equal(accepted.accepted, true);
  await updater.receive();
  await updater.refreshHealth();
  const result = updater.state.operationResults.find((item) => item.id === accepted.id);
  assert.ok(result?.completedAt);
  return result;
}
try {
  await chmod(root, 0o755);
  for (const image of [
    ...Object.values(images),
    'postgres:16-alpine',
    'redis:7-alpine',
    'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z',
  ])
    await dockerRun(['image', 'inspect', image]);
  await dockerRun(['network', 'create', network]);
  const [net] = JSON.parse(await dockerRun(['network', 'inspect', network]));
  const prefix = net.IPAM.Config[0].Subnet.split('/')[0].split('.').slice(0, 3).join('.');
  const mailbox = path.join(root, 'mailbox');
  await prepareMailbox(mailbox);
  const token = path.join(root, 'runtime-token');
  await writeFile(token, randomBytes(32).toString('hex'), { mode: 0o600 });
  const environment = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '8787',
    SERVER_EXPOSURE: 'loopback',
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'boaa',
    PGUSER: 'boaa',
    PGPASSWORD: randomBytes(24).toString('hex'),
    REDIS_URL: 'redis://redis:6379',
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'boaa-smoke',
    S3_ACCESS_KEY_ID: 'smoke',
    S3_SECRET_ACCESS_KEY: randomBytes(24).toString('hex'),
    S3_FORCE_PATH_STYLE: 'true',
    SERVER_DATA_DIR: '/data/server',
    STORAGE_CAPACITY_PATH: '/data/server',
    DEFAULT_USER_ID: 'smoke-owner',
    PROVIDER_SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    READER_AUTH_TOKEN: randomBytes(32).toString('hex'),
    AI_PROVIDER_ENABLED: 'mock',
    AI_PROVIDER_DEFAULT: 'mock',
    BOAA_RELEASE_VERSION: '1.0.0',
    BOAA_LEGACY_DATABASE_URL: '',
    BOAA_LEGACY_S3_BUCKET: '',
  };
  const volumes = (name, target, readOnly = false) => ({ type: 'volume', source: name, target, read_only: readOnly });
  const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly });
  const config = {
    name: project,
    networks: { default: { external: true, name: network } },
    volumes: Object.fromEntries(
      ['server', 'postgres', 'redis', 'minio', 'apk', 'metadata', 'providers'].map((name) => [
        name,
        { name: `${project}-${name}` },
      ]),
    ),
    services: {
      postgres: {
        image: 'postgres:16-alpine',
        environment: { POSTGRES_USER: 'boaa', POSTGRES_DB: 'boaa', POSTGRES_PASSWORD: environment.PGPASSWORD },
        volumes: [volumes('postgres', '/var/lib/postgresql/data')],
        healthcheck: health(['CMD-SHELL', 'pg_isready -U boaa -d boaa']),
      },
      redis: {
        image: 'redis:7-alpine',
        volumes: [volumes('redis', '/data')],
        healthcheck: health(['CMD', 'redis-cli', 'ping']),
      },
      minio: {
        image: 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z',
        command: ['server', '/data'],
        environment: {
          MINIO_ROOT_USER: environment.S3_ACCESS_KEY_ID,
          MINIO_ROOT_PASSWORD: environment.S3_SECRET_ACCESS_KEY,
        },
        volumes: [volumes('minio', '/data')],
        healthcheck: health(['CMD', 'curl', '-f', 'http://127.0.0.1:9000/minio/health/live']),
      },
      api: {
        image: images.server,
        command: ['node', 'dist/index.js'],
        environment: {
          ...environment,
          RUN_MIGRATIONS_ON_START: 'true',
          BOAA_UPDATER_MAILBOX: '/mailbox',
          BOAA_APK_RUNTIME_ENABLED: '0',
          BOAA_APK_RUNTIME_MANAGED: '1',
          BOAA_APK_RUNTIME_DIR: '/opt/boaa-runtimes/apk/current/runtime',
          BOAA_APK_JAVA: '/opt/boaa-runtimes/apk/current/java/bin/java',
          BOAA_RUNTIME_TOKEN_FILE: '/runtime-token',
          BOAA_SOURCE_BROWSER_PROXY_BIND: '0.0.0.0',
          BOAA_SOURCE_BROWSER_PROXY_HOST: 'api',
        },
        networks: { default: { ipv4_address: `${prefix}.230` } },
        volumes: [
          volumes('server', '/data/server'),
          volumes('apk', '/opt/boaa-runtimes/apk', true),
          bind(mailbox, '/mailbox', false),
          bind(token, '/runtime-token'),
        ],
        depends_on: Object.fromEntries(
          ['postgres', 'redis', 'minio'].map((name) => [name, { condition: 'service_healthy' }]),
        ),
        healthcheck: health([
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1))",
        ]),
      },
      worker: {
        image: images.server,
        command: ['node', 'dist/worker.js'],
        environment: { ...environment, RUN_MIGRATIONS_ON_START: 'false' },
        volumes: [volumes('server', '/data/server')],
        depends_on: { api: { condition: 'service_healthy' } },
      },
      web: {
        image: images.web,
        environment: { BOAA_RELEASE_VERSION: '1.0.0' },
        depends_on: { api: { condition: 'service_healthy' } },
        healthcheck: health(['CMD', 'wget', '-qO-', 'http://127.0.0.1/health']),
      },
      'runtime-apk': { image: images.apk, volumes: [volumes('apk', '/opt/boaa-runtimes/apk')], network_mode: 'none' },
      'runtime-browser': {
        image: images.browser,
        environment: { BOAA_RUNTIME_PORT: '8791', BOAA_RUNTIME_TOKEN_FILE: '/runtime-token' },
        volumes: [bind(token, '/runtime-token')],
      },
      'runtime-metadata': {
        image: images.metadata,
        environment: {
          BOAA_RUNTIME_PORT: '8792',
          BOAA_RUNTIME_TOKEN_FILE: '/runtime-token',
          BOAA_METADATA_PROVIDER: '/providers/provider.py',
          BOAA_METADATA_DATA_DIR: '/data',
        },
        volumes: [
          bind(token, '/runtime-token'),
          volumes('metadata', '/data'),
          volumes('providers', '/providers', true),
        ],
      },
    },
  };
  // Use the base staging method: the first forced address change belongs to the first component operation.
  current = await DockerDeployment.prototype.stage.call(
    deployment,
    config,
    { project, version: '1.0.0', schemaEpoch: 1, enabled: [], installed: [] },
    'initial',
  );
  await deployment.commit(current);
  await deployment.compose(
    current.compose,
    [
      'up',
      '-d',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'redis',
      'minio',
      'api',
      'worker',
      'web',
    ],
    180000,
  );
  console.log('PASS isolated application stack started');
  let latest = '1.1.0';
  const feed = {
    repository: 'fixture/boaa',
    releases: async () => [latest, '1.1.0', '1.0.0'].map((tag_name) => ({ tag_name })),
    manifest: async (version) => ({
      digest: version,
      manifest: {
        version,
        minimumVersion: '1.0.0',
        schemaEpoch: 1,
        rollbackSafe: true,
        images: Object.fromEntries(
          Object.keys(images).map((name) => [
            name,
            { image: name, digest: 'sha256:' + 'a'.repeat(64), platforms: [deployment.platform], downloadBytes: 1 },
          ]),
        ),
      },
    }),
  };
  updater = new ServerUpdater({ deployment, mailbox, feed });
  await updater.initialize();
  assert.equal(updater.state.available, true);
  heartbeat = setInterval(() => void updater.publish().catch(() => {}), 2000);
  await deployment.verify(current);
  await deployment.compose(current.compose, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'boaa',
    '-c',
    "CREATE TABLE smoke_preservation (value text); INSERT INTO smoke_preservation VALUES ('preserved');",
  ]);
  await apiRequest('PUT', '/api/source-network-settings', {
    revision: 0,
    defaultProxy: 'socks5://saved-proxy:1080',
    defaultMode: 'direct',
  });
  const webBefore = await deployment.compose(current.compose, ['ps', '-q', 'web']);
  for (const componentId of ['browser', 'metadata', 'apk']) {
    assert.equal((await request({ action: 'component', componentId, enabled: true })).outcome, 'complete');
    await healthyWeb();
    if (componentId === 'apk') {
      await deployment.compose(deployment.current.compose, [
        'exec',
        '-T',
        'api',
        '/opt/boaa-runtimes/apk/current/java/bin/java',
        '-cp',
        '/opt/boaa-runtimes/apk/current/runtime/target/apk-worker-0.1.0.jar:/opt/boaa-runtimes/apk/current/runtime/dependencies/*:/opt/boaa-runtimes/apk/current/runtime/smoke',
        'AndroidDispatcherSmoke',
      ]);
      console.log('PASS APK runtime/JRE executes inside receiving API image');
    }
    console.log(`PASS ${componentId} install, real API IP change and web reconnect`);
  }
  assert.equal(await deployment.compose(deployment.current.compose, ['ps', '-q', 'web']), webBefore);
  assert.equal(updater.state.components.find((item) => item.id === 'metadata').error, 'component_provider_missing');
  for (const componentId of ['apk', 'browser', 'metadata']) {
    assert.equal((await request({ action: 'component', componentId, enabled: false })).outcome, 'complete');
    await healthyWeb();
  }
  console.log('PASS optional disable preserves installed state; web follows all API addresses');
  const update = await request({ action: 'update' });
  assert.equal(update.outcome, 'complete');
  assert.equal(updater.state.currentVersion, '1.1.0');
  assert.ok((await stat(path.join(deployment.directory, 'backups', update.id, 'database.dump'))).size > 0);
  assert.ok((await stat(path.join(deployment.directory, 'backups', update.id, 'server'))).isDirectory());
  console.log('PASS update through authenticated API/mailbox, real backup and readiness');
  latest = '1.2.0';
  const failed = await request({ action: 'update' });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error, 'update_rolled_back');
  assert.equal(updater.state.currentVersion, '1.1.0');
  await healthyWeb();
  const preserved = await deployment.compose(deployment.current.compose, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'boaa',
    '-Atc',
    'SELECT value FROM smoke_preservation',
  ]);
  assert.equal(preserved, 'preserved');
  const settings = await apiRequest('GET', '/api/source-network-settings');
  assert.equal(settings.defaultMode, 'direct');
  assert.equal(settings.defaultProxy, 'socks5://saved-proxy:1080');
  clearInterval(heartbeat);
  await updater.initialize();
  assert.equal(updater.state.operationResults.find((item) => item.id === update.id).outcome, 'complete');
  assert.equal(updater.state.operationResults.find((item) => item.id === failed.id).outcome, 'failed');
  console.log('PASS actual worker startup failure rolls back; DB, proxy settings and request results preserved');
} finally {
  clearInterval(heartbeat);
  await updater?.releaseLease();
  try {
    if (current)
      await deployment.compose(current.compose, ['down', '--volumes', '--remove-orphans', '--timeout', '5'], 180000);
    await dockerRun(['network', 'rm', network]).catch(() => {});
    await rm(root, { recursive: true, force: true });
    console.log('Cleaned isolated smoke containers, volumes, network and secrets');
  } catch {
    console.error(`Smoke cleanup requires attention: project=${project}, state=${root}`);
    process.exitCode = 1;
  }
}
