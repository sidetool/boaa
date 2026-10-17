import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeEnv } from '../init-env.mjs';
import { ReleaseFeed } from './feed.mjs';
import { atomicJson } from './files.mjs';

export async function install({
  directory,
  version,
  keyFile,
  repository = 'sidetool/boaa',
  fetcher,
  run = (args) => execFileSync('docker', args, { cwd: directory, stdio: 'inherit' }),
}) {
  const publicKey = await readFile(keyFile, 'utf8');
  const { manifest } = await new ReleaseFeed({ repository, publicKey, fetcher }).manifest(version);
  const platform = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  for (const name of ['server', 'web', 'updater'])
    if (!manifest.images[name]?.platforms.includes(platform)) throw new Error('release_platform_unsupported');
  const state = path.join(directory, '.boaa-release');
  if (
    await access(path.join(state, 'installed.json')).then(
      () => true,
      () => false,
    )
  )
    throw new Error('deployment_already_installed');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const keyTarget = path.join(directory, 'deploy/release-public.pub');
  const previousKey = await readFile(keyTarget, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previousKey && previousKey.trim() !== publicKey.trim()) throw new Error('release_trust_mismatch');
  if (!previousKey) await copyFile(keyFile, keyTarget);
  initializeEnv(directory);
  const services = {};
  const names = {
    api: 'server',
    worker: 'server',
    web: 'web',
    updater: 'updater',
    'runtime-bootstrap': 'updater',
    'runtime-apk': 'apk',
    'runtime-browser': 'browser',
    'runtime-metadata': 'metadata',
  };
  for (const [service, name] of Object.entries(names)) {
    const image = manifest.images[name];
    if (!image) throw new Error('release_manifest_invalid');
    services[service] = { image: `${image.image}@${image.digest}` };
    if (['api', 'worker', 'web', 'updater'].includes(service))
      services[service].environment = { BOAA_RELEASE_VERSION: manifest.version };
  }
  services.updater.environment.BOAA_RELEASE_REPOSITORY = repository;
  services.updater.environment.BOAA_RELEASE_SCHEMA_EPOCH = String(manifest.schemaEpoch);
  const override = path.join(state, 'bootstrap.json');
  await atomicJson(override, { services });
  const compose = ['compose', '-f', path.join(directory, 'compose.release.yaml'), '-f', override];
  run([...compose, 'pull', 'runtime-bootstrap', 'web', 'api', 'worker', 'postgres', 'redis', 'minio', 'updater']);
  run([
    ...compose,
    'up',
    '-d',
    '--no-build',
    '--pull',
    'never',
    'postgres',
    'redis',
    'minio',
    'runtime-bootstrap',
    'api',
    'worker',
    'web',
    'updater',
  ]);
  await atomicJson(path.join(state, 'installed.json'), {
    version: manifest.version,
    installedAt: new Date().toISOString(),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce((pairs, value, index, args) => (index % 2 === 0 ? [...pairs, [value, args[index + 1]]] : pairs), []),
  );
  if (
    Object.keys(options).some((key) => !['--version', '--key', '--directory', '--repository'].includes(key)) ||
    !options['--version'] ||
    !options['--key']
  ) {
    console.error(
      'Usage: node scripts/release/install.mjs --version vX.Y.Z --key /trusted/public.pem [--directory /srv/boaa]',
    );
    process.exitCode = 1;
  } else {
    await install({
      directory: path.resolve(options['--directory'] || '.'),
      version: options['--version'],
      keyFile: path.resolve(options['--key']),
      repository: options['--repository'],
    }).catch(() => {
      console.error(
        'Release installation failed. Existing data was not removed; check the version, trusted key and Docker setup.',
      );
      process.exitCode = 1;
    });
  }
}
