import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generatedEnvKeys, initializeEnv } from './init-env.mjs';
import { publicE2EEnvironment } from './hosted-e2e-secrets.mjs';

const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'boaa-init-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.env.example'), template);
  return dir;
}
function values(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

test('fresh CLI install creates independent secrets without printing them; rerun preserves bytes', (t) => {
  const dir = directory(t);
  const run = () =>
    spawnSync(process.execPath, [fileURLToPath(new URL('./init-env.mjs', import.meta.url))], {
      cwd: dir,
      encoding: 'utf8',
    });
  const first = run();
  assert.equal(first.status, 0);
  const file = path.join(dir, '.env');
  const original = readFileSync(file, 'utf8');
  const env = values(original);
  assert.ok(Object.keys(generatedEnvKeys).every((key) => env[key]?.length >= 20));
  assert.ok(Object.keys(generatedEnvKeys).every((key) => !`${first.stdout}${first.stderr}`.includes(env[key])));
  assert.equal(Buffer.from(env.PROVIDER_SECRET_ENCRYPTION_KEY, 'base64').length, 32);
  assert.equal(
    new Set(Object.keys(generatedEnvKeys).map((key) => env[key])).size,
    Object.keys(generatedEnvKeys).length,
  );
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(run().status, 0);
  assert.ok(readFileSync(file, 'utf8') === original);
  const other = directory(t);
  initializeEnv(other);
  const second = values(readFileSync(path.join(other, '.env'), 'utf8'));
  assert.ok(Object.keys(generatedEnvKeys).every((key) => env[key] !== second[key]));
});

test('preserves quoted credentials and unrelated settings while filling only empty optional secrets', (t) => {
  const dir = directory(t);
  const file = path.join(dir, '.env');
  const original = [
    "POSTGRES_PASSWORD='synthetic # $ credential'",
    'MINIO_ROOT_USER="synthetic-user"',
    'MINIO_ROOT_PASSWORD=${EXISTING_STORAGE_PASSWORD}',
    'PROVIDER_SECRET_ENCRYPTION_KEY=${EXISTING_KEY}',
    'READER_AUTH_TOKEN="" # unset',
    'SUWAYOMI_AUTH_PASSWORD= # unset',
    "TEXT_SOURCE_SERVER_KEY=''",
    'CUSTOM=unchanged',
  ];
  writeFileSync(file, original.join('\r\n'));
  initializeEnv(dir);
  const output = readFileSync(file, 'utf8');
  assert.ok(original.slice(0, 4).every((line) => output.includes(line)));
  assert.ok(output.includes('CUSTOM=unchanged'));
  assert.ok(output.includes('\r\n'));
  assert.ok(values(output).READER_AUTH_TOKEN.length >= 64);
});

test('refuses to rotate implicit legacy passwords or the volume master key; fresh override is explicit', (t) => {
  const dir = directory(t);
  const file = path.join(dir, '.env');
  writeFileSync(file, template);
  assert.throws(() => initializeEnv(dir), /--new-install/);
  assert.ok(readFileSync(file, 'utf8') === template);
  initializeEnv(dir, { newInstall: true });
  assert.ok(values(readFileSync(file, 'utf8')).POSTGRES_PASSWORD.length >= 64);
});

test('duplicate secret assignments fail without rewriting existing values', (t) => {
  const dir = directory(t);
  const file = path.join(dir, '.env');
  const text = 'POSTGRES_PASSWORD=synthetic\nPOSTGRES_PASSWORD=\n';
  writeFileSync(file, text);
  assert.throws(() => initializeEnv(dir, { newInstall: true }), /중복/);
  assert.ok(readFileSync(file, 'utf8') === text);
});

test('public E2E secrets differ per run and honor environment credentials', () => {
  const first = publicE2EEnvironment({});
  const second = publicE2EEnvironment({});
  const keys = [
    'READER_AUTH_TOKEN',
    'POSTGRES_PASSWORD',
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'PROVIDER_SECRET_ENCRYPTION_KEY',
  ];
  assert.ok(keys.every((key) => first[key] && first[key] !== second[key]));
  const provided = Object.fromEntries(keys.map((key) => [key, `synthetic-${key}`]));
  const preserved = publicE2EEnvironment(provided);
  assert.ok(keys.every((key) => preserved[key] === provided[key]));
  assert.ok(preserved.HOSTED_API_AUTH_TOKEN === provided.READER_AUTH_TOKEN);
});
