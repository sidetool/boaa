import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServerUpdater } from './updater.mjs';
import { atomicJson, readJson } from './files.mjs';
import { componentConfiguration, escapeCompose, resolveInstallation } from './deployment.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'boaa-updater-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [],
    faults = {};
  const config = {
    services: {
      api: { image: 'old-server', environment: {} },
      worker: { image: 'old-server' },
      web: { image: 'old-web' },
      'runtime-apk': { image: 'old-apk' },
      'runtime-browser': { image: 'old-browser' },
      'runtime-metadata': { image: 'old-metadata' },
    },
  };
  const current = {
    project: 'fixture',
    version: '1.0.0',
    schemaEpoch: 1,
    installed: [],
    enabled: [],
    config: path.join(root, 'old.json'),
    compose: 'old-compose',
  };
  await atomicJson(current.config, config);
  const deployment = {
    directory: root,
    platform: 'linux/amd64',
    current,
    config,
    initialize: async () => {},
    stage: async (config, target) => {
      const next = { ...target, config: path.join(root, 'next.json'), compose: 'next-compose' };
      await atomicJson(next.config, config);
      return next;
    },
    pull: async () => {
      calls.push('pull');
      if (faults.pull) throw new Error('release_download_failed');
    },
    stop: async () => calls.push('stop'),
    backup: async () => {
      calls.push('backup');
      if (faults.backup) throw new Error('update_backup_failed');
    },
    apply: async (state) => {
      calls.push(`apply:${state.version}`);
      if (faults.rollback && state.version === '1.0.0') throw new Error('update_failed');
    },
    verify: async (state) => {
      calls.push(`verify:${state.version}`);
      if (faults.health && state.compose !== 'old-compose') throw new Error('update_health_failed');
    },
    commit: async (state) => {
      calls.push(`commit:${state.version}`);
      deployment.current = state;
      deployment.config = await readJson(state.config);
    },
  };
  const manifest = (version) => ({
    format: 1,
    version,
    minimumVersion: '1.0.0',
    schemaEpoch: 1,
    rollbackSafe: true,
    updaterProtocol: 1,
    images: Object.fromEntries(
      ['server', 'web', 'apk', 'browser', 'metadata'].map((name) => [
        name,
        {
          image: `ghcr.io/example/boaa-${name}`,
          digest: `sha256:${'a'.repeat(64)}`,
          platforms: ['linux/amd64'],
          downloadBytes: 123,
        },
      ]),
    ),
  });
  const feed = {
    repository: 'example/boaa',
    releases: async () => [{ tag_name: '1.1.0' }, { tag_name: '1.0.0' }],
    manifest: async (tag) => ({
      manifest: { ...manifest(tag), ...(faults.epoch ? { schemaEpoch: 2 } : {}) },
      digest: faults.changed ? 'changed' : 'sealed',
    }),
  };
  const updater = new ServerUpdater({ deployment, mailbox: path.join(root, 'mailbox'), feed, sleep: async () => {} });
  await updater.initialize();
  t.after(() => updater.releaseLease());
  updater.acquireLease = async () => {
    calls.push('lease');
    if (faults.busy) throw new Error('update_jobs_active');
  };
  return { updater, deployment, calls, faults, current, root };
}
test('check and channel change never pull images or stop services', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'check' });
  assert.equal(f.updater.state.release.version, '1.1.0');
  await f.updater.perform({ action: 'channel', channel: 'beta' });
  assert.deepEqual(f.calls, []);
});
test('update pulls before stopping, backs up before apply and verifies before committing', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'update' });
  assert.deepEqual(f.calls, ['pull', 'lease', 'stop', 'backup', 'apply:1.1.0', 'verify:1.1.0', 'commit:1.1.0']);
  assert.equal(f.updater.state.phase, 'complete');
  assert.equal(f.deployment.current.version, '1.1.0');
});
test('failed download, incompatible migration and active work do not stop the old app', async (t) => {
  for (const fault of ['pull', 'epoch', 'busy']) {
    const f = await fixture(t);
    f.faults[fault] = true;
    await f.updater.perform({ action: 'update' });
    assert.equal(f.updater.state.phase, 'failed');
    assert.ok(!f.calls.includes('stop'));
  }
});
test('unhealthy update restores the previous image combination without restoring old DB contents', async (t) => {
  const f = await fixture(t);
  f.faults.health = true;
  await f.updater.perform({ action: 'update' });
  assert.equal(f.deployment.current.version, '1.0.0');
  assert.equal(f.updater.state.error, 'update_rolled_back');
  assert.ok(f.calls.includes('apply:1.0.0'));
  assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'rolled-back');
});
test('failed rollback blocks subsequent actions and restarting cannot clear manual recovery', async (t) => {
  const f = await fixture(t);
  f.faults.health = f.faults.rollback = true;
  await f.updater.perform({ action: 'update' });
  assert.equal(f.updater.state.phase, 'recovery-required');
  const length = f.calls.length;
  assert.equal(await f.updater.perform({ action: 'update' }), false);
  assert.equal(f.calls.length, length);
  f.faults.rollback = false;
  await f.updater.initialize();
  assert.equal(f.updater.state.phase, 'recovery-required');
  assert.equal(f.updater.state.available, false);
  assert.equal(f.calls.length, length);
});
test('optional install uses current release; disabling preserves installed state and avoids download', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'component', componentId: 'apk', enabled: true });
  assert.equal(f.deployment.current.version, '1.0.0');
  assert.deepEqual(f.deployment.current.enabled, ['apk']);
  assert.deepEqual(f.deployment.current.installed, ['apk']);
  f.calls.length = 0;
  await f.updater.perform({ action: 'component', componentId: 'apk', enabled: false });
  assert.deepEqual(f.deployment.current.enabled, []);
  assert.deepEqual(f.deployment.current.installed, ['apk']);
  assert.equal(f.deployment.config.services.api.environment.BOAA_APK_RUNTIME_ENABLED, '0');
});
test('a changed signed manifest cannot silently replace an already observed release', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'check' });
  f.faults.changed = true;
  await f.updater.perform({ action: 'update' });
  assert.equal(f.updater.state.error, 'release_mutated');
  assert.deepEqual(f.calls, []);
});
test('resolved deployment preserves operator mounts and literal environment values', () => {
  const original = {
    services: {
      api: {
        environment: { TOKEN: 'literal$a' },
        volumes: [{ type: 'bind', source: './secrets', target: '/secrets' }],
      },
      worker: {},
      web: {},
    },
  };
  const config = resolveInstallation(original, {
    project: 'example',
    hostDirectory: '/srv/boaa',
    installation: '/installation',
  });
  assert.equal(config.services.api.volumes[0].source, '/srv/boaa/secrets');
  assert.equal(escapeCompose(config).services.api.environment.TOKEN, 'literal$$a');
  assert.equal(original.services.api.volumes[0].source, './secrets');
  config.services['runtime-browser'] = {};
  config.services.api.environment.BOAA_SOURCE_BROWSER_ENDPOINT = 'http://external.invalid:8791';
  assert.throws(() => componentConfiguration(config, 'browser', true), /component_external/);
});

test('retries an enabled unhealthy component without duplicating its enabled entry', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'component', componentId: 'browser', enabled: true });
  const component = f.updater.state.components.find((item) => item.id === 'browser');
  component.running = false;
  component.error = 'component_unavailable';
  f.calls.length = 0;
  await f.updater.perform({ action: 'component', componentId: 'browser', enabled: true });
  assert.deepEqual(f.deployment.current.enabled, ['browser']);
  assert.ok(f.calls.includes('apply:1.0.0'));
});
test('updating with a disabled component preserves its actually installed version', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'component', componentId: 'apk', enabled: true });
  await f.updater.perform({ action: 'component', componentId: 'apk', enabled: false });
  await f.updater.perform({ action: 'update' });
  assert.equal(f.updater.state.currentVersion, '1.1.0');
  assert.equal(f.updater.state.components.find((item) => item.id === 'apk').version, '1.0.0');
});

test('manual recovery keeps its diagnostic reason instead of becoming generic deployment drift', async (t) => {
  const f = await fixture(t);
  f.updater.state.phase = 'recovery-required';
  f.updater.state.available = false;
  f.updater.state.reason = 'update_recovery_required';
  f.deployment.assertCurrentMatches = async () => {
    throw new Error('deployment_drift');
  };
  await f.updater.refreshHealth();
  assert.equal(f.updater.state.reason, 'update_recovery_required');
  assert.equal(f.updater.state.phase, 'recovery-required');
});

async function restartAfterCrash(t, f, phase, journal) {
  const operation = {
    id: '11111111-1111-1111-1111-111111111111',
    action: 'update',
    startedAt: new Date().toISOString(),
  };
  await atomicJson(path.join(f.root, 'status.json'), { ...f.updater.state, phase, busy: true, operation });
  if (journal) await atomicJson(path.join(f.root, 'journal.json'), { ...journal, operation });
  const restarted = new ServerUpdater({ deployment: f.deployment, mailbox: f.updater.mailbox, feed: f.updater.feed });
  t.after(() => restarted.releaseLease());
  await restarted.initialize();
  return restarted;
}

test('a crash before journaling ends the request and releases maintenance instead of leaving an active phase', async (t) => {
  for (const phase of ['checking', 'downloading', 'preflight']) {
    const f = await fixture(t);
    await atomicJson(path.join(f.updater.mailbox, 'maintenance.json'), {
      id: 'abandoned',
      expiresAt: Date.now() + 120000,
    });
    const restarted = await restartAfterCrash(t, f, phase);
    assert.equal(restarted.state.phase, 'failed');
    assert.equal(restarted.state.error, 'update_interrupted');
    assert.equal(restarted.state.busy, false);
    assert.ok(restarted.state.operation.completedAt);
    assert.equal(restarted.state.operationResults[0].outcome, 'failed');
    assert.equal(await readJson(path.join(f.updater.mailbox, 'maintenance.json'), null), null);
    assert.deepEqual(f.calls, []);
  }
});

test('a real interrupted apply rolls back and persists the result for the original request id', async (t) => {
  const f = await fixture(t);
  const target = await f.deployment.stage(f.deployment.config, { ...f.current, version: '1.1.0' });
  const restarted = await restartAfterCrash(t, f, 'applying', { previous: f.current, target, phase: 'applying' });
  assert.deepEqual(f.calls, ['stop', 'apply:1.0.0', 'verify:1.0.0', 'commit:1.0.0']);
  assert.equal(restarted.state.error, 'update_rolled_back');
  assert.ok(restarted.state.operation.completedAt);
  assert.equal(restarted.state.operationResults[0].id, restarted.state.operation.id);
  assert.equal(restarted.state.operationResults[0].outcome, 'failed');
});

test('committed targets survive a crash before final journal or status publication', async (t) => {
  for (const phase of ['verifying', 'complete']) {
    const f = await fixture(t);
    const previous = f.current;
    const target = await f.deployment.stage(f.deployment.config, { ...previous, version: '1.1.0' });
    await f.deployment.commit(target);
    f.calls.length = 0;
    const restarted = await restartAfterCrash(t, f, 'verifying', { previous, target, phase });
    assert.equal(restarted.state.phase, 'complete');
    assert.equal(restarted.state.currentVersion, '1.1.0');
    assert.equal(restarted.state.operationResults[0].outcome, 'complete');
    assert.ok(!f.calls.some((call) => call.startsWith('apply:')));
    assert.equal((await readJson(path.join(f.root, 'journal.json'))).phase, 'complete');
  }
});

test('startup rollback failure remains fenced and publishes a completed recovery-required result', async (t) => {
  const f = await fixture(t);
  f.faults.rollback = true;
  const target = await f.deployment.stage(f.deployment.config, { ...f.current, version: '1.1.0' });
  const restarted = await restartAfterCrash(t, f, 'applying', { previous: f.current, target, phase: 'applying' });
  assert.equal(restarted.state.phase, 'recovery-required');
  assert.equal(restarted.state.available, false);
  assert.equal(restarted.state.operationResults[0].outcome, 'recovery-required');
  assert.ok(restarted.state.operation.completedAt);
});

test('completed request outcomes survive later checks and restarts and are bounded', async (t) => {
  const f = await fixture(t);
  await f.updater.perform({ action: 'check' }, 'original-request');
  await f.updater.perform({ action: 'check' }, 'automatic-check');
  await f.updater.initialize();
  assert.equal(f.updater.state.operationResults.find((item) => item.id === 'original-request').outcome, 'complete');
  for (let i = 0; i < 33; i++) await f.updater.perform({ action: 'check' }, `later-${i}`);
  assert.equal(f.updater.state.operationResults.length, 32);
  assert.equal(f.updater.state.operationResults.at(-1).id, 'later-32');
});

test('a claimed request interrupted before operation publication gets a known result without being replayed', async (t) => {
  const f = await fixture(t);
  const id = '22222222-2222-2222-2222-222222222222';
  await atomicJson(path.join(f.updater.mailbox, 'processing.json'), {
    id,
    requestedAt: Date.now(),
    request: { action: 'update' },
  });
  await f.updater.initialize();
  assert.equal(f.updater.state.operationResults.find((item) => item.id === id).error, 'update_interrupted');
  assert.equal(await readJson(path.join(f.updater.mailbox, 'processing.json'), null), null);
  assert.deepEqual(f.calls, []);
});

test('accepted requests that expire or become unavailable get a result instead of silently disappearing', async (t) => {
  for (const expired of [true, false]) {
    const f = await fixture(t);
    const id = '33333333-3333-3333-3333-333333333333';
    if (!expired) {
      f.updater.state.available = false;
      f.updater.state.reason = 'deployment_drift';
    }
    await atomicJson(path.join(f.updater.mailbox, 'request.json'), {
      id,
      requestedAt: Date.now() - (expired ? 120000 : 0),
      request: { action: 'update' },
    });
    await f.updater.receive();
    const result = f.updater.state.operationResults.find((item) => item.id === id);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error, expired ? 'management_request_expired' : 'deployment_drift');
    assert.deepEqual(f.calls, []);
  }
});
