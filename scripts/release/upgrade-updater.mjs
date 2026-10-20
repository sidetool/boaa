import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseFeed } from './feed.mjs';
import { DockerDeployment } from './deployment.mjs';
import { atomicJson, readJson } from './files.mjs';

// Run under the updater's existing flock. Only updater image/config changes; no application or data restart.
export async function stageUpdaterImage(deployment, image) {
  if (!/^ghcr\.io\/[a-z0-9_-]+\/boaa-updater@sha256:[a-f0-9]{64}$/.test(image)) throw Error('release_image_invalid');
  await deployment.initialize();
  const status = await readJson(path.join(deployment.directory, 'status.json'), {});
  const journal = await readJson(path.join(deployment.directory, 'journal.json'), null);
  if (
    status.busy ||
    status.phase === 'recovery-required' ||
    (journal && !['complete', 'rolled-back', 'cancelled'].includes(journal.phase))
  )
    throw Error('management_busy');
  const previous = deployment.current;
  const id = `updater-${randomUUID()}`;
  await atomicJson(path.join(deployment.directory, 'operator-backups', id, 'current.json'), previous);
  const config = structuredClone(deployment.config);
  config.services.updater.image = image;
  const target = await deployment.stage(config, previous, id);
  const create = (state) =>
    deployment.compose(state.compose, ['up', '--no-start', '--no-deps', '--pull', 'never', 'updater']);
  try {
    await create(target);
    await deployment.commit(target);
  } catch (error) {
    await create(previous);
    await deployment.commit(previous);
    throw error;
  }
}

export async function upgradeUpdater({ container, version, keyFile, repository = 'sidetool/boaa', run, fetcher }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container)) throw Error('deployment_container_invalid');
  const docker = run ?? ((args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const publicKey = await readFile(keyFile, 'utf8');
  const { manifest } = await new ReleaseFeed({ repository, publicKey, fetcher }).manifest(version);
  const [actual] = JSON.parse(docker(['inspect', container]));
  if (actual.Config?.Labels?.['com.docker.compose.service'] !== 'updater') throw Error('deployment_container_invalid');
  const image = manifest.images.updater;
  const platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  if (!image?.platforms.includes(platform)) throw Error('release_platform_unsupported');
  const reference = `${image.image}@${image.digest}`;
  docker(['pull', '--platform', platform, reference]);
  docker([
    'exec',
    container,
    'node',
    '-e',
    "const fs=require('fs');const s=JSON.parse(fs.readFileSync('/state/status.json'));let j;try{j=JSON.parse(fs.readFileSync('/state/journal.json'))}catch{}if(s.busy||s.phase==='recovery-required'||(j&&!['complete','rolled-back','cancelled'].includes(j.phase)))process.exit(1)",
  ]);
  docker(['stop', '--time', '30', container]);
  try {
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:1000',
      '--volumes-from',
      container,
      reference,
      'flock',
      '-n',
      '-F',
      '/state/updater.lock',
      'node',
      'scripts/release/upgrade-updater.mjs',
      '--apply-image',
      reference,
    ]);
  } finally {
    docker(['start', container]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 2 && args[0] === '--apply-image') await stageUpdaterImage(new DockerDeployment(), args[1]);
    else {
      if (args.length % 2) throw Error('usage');
      const options = Object.fromEntries(
        Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]),
      );
      if (
        Object.keys(options).some((k) => !['--container', '--version', '--key', '--repository'].includes(k)) ||
        !options['--container'] ||
        !options['--version'] ||
        !options['--key']
      )
        throw Error('usage');
      await upgradeUpdater({
        container: options['--container'],
        version: options['--version'],
        keyFile: options['--key'],
        repository: options['--repository'],
      });
    }
    console.log('Updater upgraded. Application images and data were preserved.');
  } catch {
    console.error('Updater upgrade failed. Verify the container status and private updater state before retrying.');
    process.exitCode = 1;
  }
}
