import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readJson, validateRequest } from './files.mjs';
import { compareVersions, ReleaseFeed } from './feed.mjs';
import { COMPONENTS, CORE, DockerDeployment, componentConfiguration, imageFor, prepareMailbox } from './deployment.mjs';
import { OPERATION_RESULT_LIMIT, recordOperationResult } from './operation-results.mjs';

const safeError = (error) =>
  /^(?:release|deployment|update|updater|component|management)_[a-z_]+$/.test(error?.message ?? '')
    ? error.message
    : 'update_failed';
const iso = () => new Date().toISOString();
const terminal = (phase) => ['complete', 'failed', 'recovery-required', 'idle'].includes(phase);
const journalFinished = (phase) => ['complete', 'rolled-back', 'cancelled'].includes(phase);
const sameDeployment = (left, right) =>
  Boolean(
    left && right && left.version === right.version && left.config === right.config && left.compose === right.compose,
  );
export class ServerUpdater {
  constructor({ deployment = new DockerDeployment(), mailbox = '/mailbox', feed, sleep = delay } = {}) {
    this.deployment = deployment;
    this.mailbox = mailbox;
    this.feed = feed;
    this.sleep = sleep;
    this.state = {
      available: false,
      currentVersion: 'unknown',
      channel: 'stable',
      phase: 'idle',
      busy: false,
      components: [],
    };
  }
  get root() {
    return this.deployment.directory;
  }
  async publish() {
    await atomicJson(path.join(this.mailbox, 'status.json'), { heartbeat: Date.now(), status: this.state }, 0o660);
    await atomicJson(path.join(this.root, 'status.json'), this.state);
  }
  async phase(phase, fields = {}) {
    Object.assign(this.state, fields, { phase });
    await this.publish();
  }
  async initialize() {
    await prepareMailbox(this.mailbox);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const saved = await readJson(path.join(this.root, 'status.json'), null);
    if (saved) this.state = { ...saved, available: false, busy: false };
    this.state.operationResults = (this.state.operationResults || []).slice(-OPERATION_RESULT_LIMIT);
    try {
      // A restart is not an operator recovery action. Keep the failed-recovery fence in place.
      const manualRecovery = saved?.phase === 'recovery-required';
      await this.deployment.initialize({ allowDrift: manualRecovery });
      this.state.currentVersion = this.deployment.current.version;
      if (manualRecovery) throw new Error('update_recovery_required');
      this.state.available = true;
      delete this.state.reason;
      const journal = await readJson(path.join(this.root, 'journal.json'), null);
      if (journal && !journalFinished(journal.phase)) {
        if (journal.operation) this.state.operation = { ...journal.operation };
        // commit(current.json) is the durable success point. A crash before the final journal/status
        // writes must not roll back a verified and committed deployment just because its status is old.
        if (sameDeployment(this.deployment.current, journal.target) && journal.phase !== 'rolling-back') {
          try {
            await this.deployment.verify(journal.target);
            await this.deployment.assertCurrentMatches?.();
            await this.journal(journal, 'complete');
            this.state.phase = 'complete';
            delete this.state.error;
          } catch {
            await this.rollback(journal);
          }
        } else await this.rollback(journal);
      } else if (this.state.operation && !this.state.operation.completedAt) {
        const matches = journal?.operation?.id === this.state.operation.id;
        if (matches && journal.phase === 'complete' && sameDeployment(this.deployment.current, journal.target)) {
          this.state.phase = 'complete';
          delete this.state.error;
        } else if (matches && journal.phase === 'rolled-back') {
          this.state.phase = 'failed';
          this.state.error = 'update_rolled_back';
        } else if (!terminal(this.state.phase) || this.state.phase === 'idle') {
          this.state.phase = 'failed';
          this.state.error = 'update_interrupted';
        }
      } else if (!terminal(this.state.phase)) {
        this.state.phase = 'failed';
        this.state.error = 'update_interrupted';
      }
      this.refreshComponents();
    } catch (error) {
      this.state.available = false;
      this.state.reason = safeError(error);
      if (this.state.phase !== 'recovery-required' && !terminal(this.state.phase)) {
        this.state.phase = 'failed';
        this.state.error = safeError(error);
      }
    }
    this.state.busy = false;
    if (
      this.state.operation &&
      (!this.state.operation.completedAt ||
        !this.state.operationResults.some((item) => item.id === this.state.operation.id))
    )
      recordOperationResult(
        this.state,
        this.state.operation,
        this.state.phase === 'complete'
          ? 'complete'
          : this.state.phase === 'recovery-required'
            ? 'recovery-required'
            : 'failed',
        this.state.error,
      );
    // The updater can die after claiming the mailbox but before publishing the operation.
    const processing = await readJson(path.join(this.mailbox, 'processing.json'), null, 4096).catch(() => null);
    if (processing && !this.state.operationResults.some((item) => item.id === processing.id)) {
      try {
        const request = validateRequest(processing.request);
        if (/^[0-9a-f-]{36}$/.test(processing.id) && Number.isFinite(processing.requestedAt))
          recordOperationResult(
            this.state,
            { ...request, id: processing.id, startedAt: new Date(processing.requestedAt).toISOString() },
            'failed',
            'update_interrupted',
          );
      } catch {
        /* Invalid mailbox content never becomes an operation. */
      }
    }
    await unlink(path.join(this.mailbox, 'processing.json')).catch(() => {});
    if (this.state.phase !== 'recovery-required') await this.releaseLease();
    await this.publish();
  }
  refreshComponents(manifest) {
    const { current, config, platform } = this.deployment;
    if (!current) return;
    const env = config.services.api.environment;
    this.state.components = Object.keys(COMPONENTS).map((id) => {
      const before = this.state.components.find((component) => component.id === id);
      const image = manifest?.images[id];
      const endpoint =
        id === 'browser'
          ? env.BOAA_SOURCE_BROWSER_ENDPOINT
          : id === 'metadata'
            ? env.WEBNOVEL_METADATA_COLLECTOR_URL
            : '';
      const external = Boolean(
        endpoint && endpoint !== (id === 'browser' ? 'http://runtime-browser:8791' : 'http://runtime-metadata:8792'),
      );
      return {
        id,
        installed: current.installed.includes(id) || current.enabled.includes(id),
        enabled: current.enabled.includes(id),
        running: current.enabled.includes(id) && Boolean(before?.running),
        managed: !external,
        supported:
          Boolean(config.services[COMPONENTS[id]]) &&
          (image ? image.platforms.includes(platform) : (before?.supported ?? true)),
        ...(image
          ? { downloadBytes: image.downloadBytes }
          : before?.downloadBytes !== undefined
            ? { downloadBytes: before.downloadBytes }
            : {}),
        ...(current.installed.includes(id)
          ? { version: current.componentVersions?.[id] || before?.version || current.version }
          : {}),
        ...(external ? { error: 'component_external' } : {}),
      };
    });
  }
  async refreshHealth() {
    if (this.state.phase === 'recovery-required') return;
    if (!this.state.busy && this.deployment.current && this.deployment.assertCurrentMatches) {
      try {
        await this.deployment.assertCurrentMatches();
        if (this.state.reason === 'deployment_drift') {
          this.state.available = true;
          delete this.state.reason;
        }
      } catch {
        this.state.available = false;
        this.state.reason = 'deployment_drift';
        await this.publish();
        return;
      }
    }
    if (this.state.busy || !this.deployment.componentHealth) return;
    for (const component of this.state.components) {
      if (!component.enabled || !component.managed) {
        component.running = false;
        continue;
      }
      const health = await this.deployment
        .componentHealth(component.id)
        .catch(() => ({ running: false, error: 'component_unavailable' }));
      Object.assign(component, health);
      if (!health.error) delete component.error;
    }
    await this.publish();
  }
  async sealed(tag) {
    const release = await this.feed.manifest(tag);
    const sealFile = path.join(this.root, 'seals', release.manifest.version + '.json');
    const old = await readJson(sealFile, null);
    if (old && old.digest !== release.digest) throw new Error('release_mutated');
    await atomicJson(sealFile, { digest: release.digest });
    return release;
  }
  async check() {
    await this.phase('checking');
    const releases = await this.feed.releases(this.state.channel);
    const next = releases.find((row) => compareVersions(row.tag_name, this.state.currentVersion) > 0);
    delete this.state.release;
    this.candidate = undefined;
    if (next) {
      this.candidate = { ...(await this.sealed(next.tag_name)), tag: next.tag_name };
      this.state.release = {
        version: this.candidate.manifest.version,
        publishedAt: typeof next.published_at === 'string' ? next.published_at : '',
        notes: typeof next.body === 'string' ? next.body.slice(0, 32000) : '',
        url: `https://github.com/${this.feed.repository}/releases/tag/${encodeURIComponent(next.tag_name)}`,
      };
    }
    this.state.checkedAt = iso();
    // Component installation always uses this app version, independently of the selected update channel.
    const current = releases.find((row) => compareVersions(row.tag_name, this.state.currentVersion) === 0);
    if (current) this.refreshComponents((await this.sealed(current.tag_name)).manifest);
  }
  compatible(manifest) {
    if (
      compareVersions(this.state.currentVersion, manifest.minimumVersion) < 0 ||
      this.deployment.current.schemaEpoch !== manifest.schemaEpoch ||
      !manifest.rollbackSafe
    )
      throw new Error('update_migration_required');
  }
  async acquireLease() {
    const id = randomUUID();
    await this.startLease(id);
    for (let attempt = 0; attempt < 15; attempt++) {
      const activity = await readJson(path.join(this.mailbox, 'activity.json'), null, 4096);
      if (
        activity?.leaseId === id &&
        activity.idle &&
        Date.now() - activity.timestamp < 5000 &&
        activity.timestamp <= Date.now()
      )
        return;
      await this.sleep(1000);
    }
    throw new Error('update_jobs_active');
  }
  async startLease(id = randomUUID()) {
    clearInterval(this.leaseTimer);
    const heartbeat = async () =>
      atomicJson(path.join(this.mailbox, 'maintenance.json'), { id, expiresAt: Date.now() + 120_000 }, 0o660);
    await heartbeat();
    this.leaseTimer = setInterval(() => void heartbeat().catch(() => {}), 5000);
    this.leaseTimer.unref();
  }
  async releaseLease() {
    clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    await unlink(path.join(this.mailbox, 'maintenance.json')).catch(() => {});
  }
  async journal(transaction, phase) {
    transaction.phase = phase;
    await atomicJson(path.join(this.root, 'journal.json'), transaction);
  }
  async rollback(transaction) {
    await this.startLease();
    await this.phase('rolling-back', { busy: true });
    try {
      if (transaction.previous.schemaEpoch !== transaction.target.schemaEpoch)
        throw new Error('update_recovery_required');
      await this.journal(transaction, 'rolling-back');
      await this.deployment.stop(transaction.target);
      await this.deployment.apply(transaction.previous);
      await this.deployment.verify(transaction.previous);
      await this.deployment.commit(transaction.previous);
      await this.journal(transaction, 'rolled-back');
      this.state.currentVersion = transaction.previous.version;
      this.refreshComponents();
      await this.phase('failed', { error: 'update_rolled_back', busy: false });
      await this.releaseLease();
    } catch {
      await this.phase('recovery-required', { error: 'update_recovery_required', busy: false });
      throw new Error('update_recovery_required');
    }
  }
  async change(request) {
    await this.deployment.assertCurrentMatches?.();
    const previous = this.deployment.current;
    let config = structuredClone(this.deployment.config),
      target = { ...previous, enabled: [...previous.enabled], installed: [...previous.installed] };
    let release;
    if (request.action === 'component') {
      const item = this.state.components.find((item) => item.id === request.componentId);
      if (!item?.managed) throw new Error('component_external');
      if (!item.supported) throw new Error('component_unsupported');
      if (item.enabled === request.enabled && (!request.enabled || (item.running && !item.error))) return;
      config = componentConfiguration(config, request.componentId, request.enabled);
      if (request.enabled) {
        const releases = await this.feed.releases('beta');
        const current = releases.find((row) => compareVersions(row.tag_name, previous.version) === 0);
        if (!current) throw new Error('release_not_found');
        release = await this.sealed(current.tag_name);
        target.enabled = [...new Set([...target.enabled, request.componentId])];
        target.installed = [...new Set([...target.installed, request.componentId])];
        target.componentVersions = { ...target.componentVersions, [request.componentId]: previous.version };
      } else target.enabled = target.enabled.filter((id) => id !== request.componentId);
    } else {
      // Re-fetch and verify the candidate at installation time; never execute a URL supplied by the browser.
      await this.check();
      if (!this.candidate) throw new Error('release_not_found');
      release = await this.sealed(this.candidate.tag);
      this.compatible(release.manifest);
      target.version = release.manifest.version;
      target.schemaEpoch = release.manifest.schemaEpoch;
      target.componentVersions = {
        ...target.componentVersions,
        ...Object.fromEntries(target.enabled.map((id) => [id, target.version])),
      };
    }
    const services =
      request.action === 'component'
        ? request.enabled
          ? [COMPONENTS[request.componentId]]
          : []
        : [...CORE, ...target.enabled.map((id) => COMPONENTS[id])];
    if (release) {
      for (const service of services) {
        const image = release.manifest.images[imageFor(service)];
        if (!image?.platforms.includes(this.deployment.platform)) throw new Error('component_unsupported');
        config.services[service].image = `${image.image}@${image.digest}`;
      }
    }
    if (request.action === 'update') {
      for (const service of CORE) (config.services[service].environment ??= {}).BOAA_RELEASE_VERSION = target.version;
    }
    await this.phase('downloading');
    await this.deployment.pull(config, services);
    target = await this.deployment.stage(config, target, randomUUID());
    await this.phase('preflight');
    let transaction;
    try {
      await this.acquireLease();
      transaction = { previous, target, operation: this.state.operation, phase: 'prepared' };
      await this.journal(transaction, 'prepared');
      await this.deployment.stop(previous);
      await this.journal(transaction, 'stopped');
      if (request.action === 'update') {
        await this.phase('backup');
        await this.deployment.backup(previous, this.state.operation.id);
        await this.journal(transaction, 'backed-up');
      }
      await this.phase('applying');
      await this.journal(transaction, 'applying');
      await this.deployment.apply(target);
      await this.phase('verifying');
      await this.journal(transaction, 'verifying');
      await this.deployment.verify(target);
      await this.deployment.commit(target);
      await this.journal(transaction, 'complete');
      this.state.currentVersion = target.version;
      if (request.action === 'update') delete this.state.release;
      this.refreshComponents(release?.manifest);
    } catch (error) {
      if (transaction) await this.rollback(transaction);
      throw error;
    } finally {
      if (this.state.phase !== 'recovery-required') await this.releaseLease();
    }
  }
  async perform(input, id = randomUUID()) {
    if (this.state.busy || !this.state.available || this.state.phase === 'recovery-required') return false;
    const request = validateRequest(input);
    this.state.busy = true;
    this.state.phase = 'idle';
    delete this.state.error;
    this.state.operation = {
      id,
      action: request.action,
      ...(request.componentId ? { componentId: request.componentId, enabled: request.enabled } : {}),
      startedAt: iso(),
    };
    await this.publish();
    try {
      if (request.action === 'channel') {
        this.state.channel = request.channel;
        await this.check();
      } else if (request.action === 'check') await this.check();
      else await this.change(request);
      await this.phase('complete');
    } catch (error) {
      if (this.state.phase !== 'recovery-required')
        await this.phase('failed', {
          error: this.state.error === 'update_rolled_back' ? 'update_rolled_back' : safeError(error),
        });
    } finally {
      this.state.busy = false;
      recordOperationResult(
        this.state,
        this.state.operation,
        this.state.phase === 'complete'
          ? 'complete'
          : this.state.phase === 'recovery-required'
            ? 'recovery-required'
            : 'failed',
        this.state.error,
      );
      await this.publish();
    }
    return true;
  }
  async receive() {
    if (this.state.busy) return;
    let message;
    try {
      message = await readJson(path.join(this.mailbox, 'request.json'), null, 4096);
    } catch {
      await unlink(path.join(this.mailbox, 'request.json')).catch(() => {});
      return;
    }
    if (!message) return;
    await rename(path.join(this.mailbox, 'request.json'), path.join(this.mailbox, 'processing.json'));
    try {
      if (
        !/^[0-9a-f-]{36}$/.test(message.id) ||
        !Number.isFinite(message.requestedAt) ||
        message.requestedAt > Date.now() + 5000
      )
        throw new Error('management_request_invalid');
      const request = validateRequest(message.request);
      const expired = Date.now() - message.requestedAt > 60_000;
      if (expired || !(await this.perform(request, message.id))) {
        recordOperationResult(
          this.state,
          { ...request, id: message.id, startedAt: new Date(message.requestedAt).toISOString() },
          'failed',
          expired ? 'management_request_expired' : this.state.reason || 'management_unavailable',
        );
        await this.publish();
      }
    } catch {
      /* Malformed mailbox requests never execute commands. */
    } finally {
      await unlink(path.join(this.mailbox, 'processing.json')).catch(() => {});
    }
  }
}

async function main() {
  const publicKey = await readFile(
    process.env.BOAA_RELEASE_PUBLIC_KEY_FILE || '/installation/deploy/release-public.pem',
    'utf8',
  ).catch(() => '');
  const updater = new ServerUpdater({
    feed: new ReleaseFeed({ publicKey, repository: process.env.BOAA_RELEASE_REPOSITORY || 'sidetool/boaa' }),
  });
  await updater.initialize();
  const heartbeat = setInterval(() => void updater.publish().catch(() => {}), 5000);
  let lastHealth = 0;
  let closed = false,
    lastCheck = Date.parse(updater.state.checkedAt || '') || 0;
  const close = () => {
    closed = true;
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  try {
    while (!closed) {
      await updater.receive();
      lastCheck = Math.max(lastCheck, Date.parse(updater.state.checkedAt || '') || 0);
      if (Date.now() - lastHealth > 30_000) {
        await updater.refreshHealth();
        lastHealth = Date.now();
      }
      if (
        !updater.state.busy &&
        updater.state.available &&
        Date.now() - lastCheck > (updater.state.error ? 60 * 60_000 : 6 * 60 * 60_000)
      ) {
        lastCheck = Date.now();
        await updater.perform({ action: 'check' });
      }
      await delay(1000);
    }
  } finally {
    clearInterval(heartbeat);
    if (updater.state.phase !== 'recovery-required') await updater.releaseLease();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('BOAA updater stopped; inspect the private recovery state.');
    process.exitCode = 1;
  });
}
