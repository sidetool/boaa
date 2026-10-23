// Isolated opt-in lifecycle test. Only the temporary project and volume are removed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerDeployment, escapeCompose } from './deployment.mjs';
import { atomicJson } from './files.mjs';
import { withOptionalTTS, TTS_MODEL_REVISION } from './tts-component.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'boaa-tts-smoke-'));
const project = path.basename(directory).toLowerCase();
const execute = promisify(execFile);
const deployment = new DockerDeployment({
  directory,
  run: async (args, timeout = 120_000) =>
    (await execute('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(),
});
deployment.project = project;
const config = withOptionalTTS({ services: {} }, project);
// No inter-service networking is needed; do not allocate another subnet on a busy host.
config.services['plain-tts'].network_mode = 'bridge';
config.services['plain-tts'].image = process.env.BOAA_TTS_SMOKE_IMAGE || 'boaa-tts:optional-review';
const compose = path.join(directory, 'compose.json');
await atomicJson(compose, escapeCompose(config));
const state = { compose };
try {
  await deployment.prepareComponents(state, ['plain-tts']);
  // The model installer has exited; downloading weights alone starts no inference service.
  assert.equal(await deployment.compose(compose, ['ps', '-q', '--status', 'running']), '');
  await deployment.compose(
    compose,
    ['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '120', 'plain-tts'],
    180_000,
  );
  const container = await deployment.compose(compose, ['ps', '-q', 'plain-tts']);
  const probe = `
import json,urllib.request,wave,io
base='http://127.0.0.1:9010'
health=json.load(urllib.request.urlopen(base+'/health'))
assert health['ready'] and health['revision']=='${TTS_MODEL_REVISION}'
voices=json.load(urllib.request.urlopen(base+'/voices'))['voices']
assert len(voices)==10
body=json.dumps({'modelId':'supertonic-3-ko','text':'안녕하세요. 음성 설치 확인입니다.','voiceId':voices[0]['id'],'speed':1,'format':'wav'}).encode()
request=urllib.request.Request(base+'/synthesize',data=body,headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=60) as response:
 assert response.headers['Content-Type']=='audio/wav'
 with wave.open(io.BytesIO(response.read())) as audio:
  assert audio.getnframes()>0
print('health, ten voices and real Korean synthesis: PASS')
`;
  console.log(await deployment.run(['exec', container, 'python', '-c', probe], 90_000));
  await deployment.compose(compose, ['stop', '--timeout', '30', 'plain-tts'], 60_000);
  assert.equal(await deployment.compose(compose, ['ps', '-q', '--status', 'running']), '');
  // Re-enable from exactly the saved volume with networking disabled: no repeated model download.
  console.log(
    await deployment.run(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--memory',
        '256m',
        '-v',
        `${project}_plain-tts-models:/models`,
        config.services['plain-tts'].image,
        'python',
        'install.py',
        '--directory',
        '/models',
      ],
      60_000,
    ),
  );
  await deployment.compose(
    compose,
    ['up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '120', 'plain-tts'],
    180_000,
  );
  console.log('opt-in preparation, stop and reuse of verified model files: PASS');
} finally {
  try {
    await deployment.compose(compose, ['--profile', '*', 'down', '--volumes', '--remove-orphans'], 60_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
