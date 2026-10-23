import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { withOptionalTTS, TTS_ENDPOINT, TTS_MODEL_ID, TTS_MODEL_REVISION, TTS_MODEL_BYTES } from './tts-component.mjs';
import { componentConfiguration, imageFor, DockerDeployment } from './deployment.mjs';
import { validateRequest } from './files.mjs';

test('managed TTS pins the same verified bundle as the runtime and only changes plain narration configuration', async () => {
  const model = JSON.parse(await readFile(new URL('../../deploy/plain-tts/model-manifest.json', import.meta.url)));
  assert.equal(TTS_MODEL_REVISION, model.revision);
  assert.equal(
    TTS_MODEL_BYTES,
    model.files.reduce((sum, file) => sum + file.size, 0),
  );
  const base = { services: { api: { environment: { TTS_PROVIDER_DEFAULT: 'openai' } } } };
  const seeded = withOptionalTTS(base, 'fixture');
  assert.equal(base.services['plain-tts'], undefined);
  assert.deepEqual(seeded.services['plain-tts'].profiles, ['tts']);
  assert.equal(seeded.services['plain-tts'].environment.MODEL_AUTO_INSTALL, 'false');
  assert.equal(seeded.volumes['plain-tts-models'].name, 'fixture_plain-tts-models');
  const enabled = componentConfiguration(seeded, 'tts', true);
  const env = enabled.services.api.environment;
  assert.equal(env.TTS_PLAIN_ENABLED, 'true');
  assert.equal(env.TTS_PLAIN_ENDPOINT_URL, TTS_ENDPOINT);
  assert.equal(env.TTS_PLAIN_MODEL_ID, TTS_MODEL_ID);
  assert.equal(env.TTS_PROVIDER_DEFAULT, 'openai');
  assert.equal(imageFor('plain-tts'), 'tts');
  assert.equal(withOptionalTTS(enabled, 'fixture'), enabled);
  assert.deepEqual(validateRequest({ action: 'component', componentId: 'tts', enabled: true }), {
    action: 'component',
    componentId: 'tts',
    enabled: true,
  });
  assert.throws(() => validateRequest({ action: 'component', componentId: 'tts', enabled: true, engine: 'camoufox' }));
});

test('model preparation is a bounded one-shot command, never an inference service or implicit dependency start', async () => {
  const calls = [];
  const deployment = new DockerDeployment({
    run: async (args, timeout) => {
      calls.push({ args, timeout });
      return '';
    },
  });
  deployment.project = 'fixture';
  await deployment.prepareComponents({ compose: 'target.json' }, ['api', 'web']);
  assert.equal(calls.length, 0);
  await deployment.prepareComponents({ compose: 'target.json' }, ['plain-tts']);
  assert.deepEqual(calls[0].args.slice(5), [
    'run',
    '--rm',
    '--name',
    calls[0].args[8],
    '--no-deps',
    '--pull',
    'never',
    '-T',
    'plain-tts',
    'python',
    'install.py',
    '--directory',
    '/models',
  ]);
  assert.equal(calls[0].timeout, 20 * 60_000);
  assert.match(calls[0].args[8], /^fixture-tts-install-/);
  assert.deepEqual(calls[1].args, ['rm', '-f', calls[0].args[8]]);
});

test('default Compose services exclude Supertonic and its model volume is never an application dependency', () => {
  const file = new URL('../../compose.release.yaml', import.meta.url).pathname;
  const active = execFileSync('docker', ['compose', '-f', file, 'config', '--services'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  })
    .trim()
    .split('\n');
  assert.ok(!active.includes('plain-tts'));
  const all = JSON.parse(
    execFileSync('docker', ['compose', '-f', file, '--profile', '*', 'config', '--format', 'json'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }),
  );
  assert.deepEqual(all.services['plain-tts'].profiles, ['tts']);
  for (const name of ['api', 'worker', 'web']) assert.ok(!all.services[name].depends_on?.['plain-tts']);
  assert.notEqual(all.services.api.environment.TTS_PLAIN_ENABLED, 'true');
});

test('a timed-out model preparation cleans up its own installer container', async () => {
  const calls = [];
  const deployment = new DockerDeployment({
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'compose') throw new Error('deployment_command_failed');
      return '';
    },
  });
  deployment.project = 'fixture';
  await assert.rejects(
    deployment.prepareComponents({ compose: 'target.json' }, ['plain-tts']),
    /deployment_command_failed/,
  );
  assert.deepEqual(calls[1], ['rm', '-f', calls[0][8]]);
});
