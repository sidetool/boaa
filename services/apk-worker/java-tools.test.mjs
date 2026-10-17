import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJavaApkTools } from './java-tools.mjs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

test('injects the current default into every real stdio request and fingerprints private preference changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-java-network-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dependencies'));
  const java = join(root, 'java-fixture');
  await writeFile(
    java,
    `#!${process.execPath}
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, result: { defaultProxy: request.params.defaultProxy } }));
}
`,
    { mode: 0o700 },
  );
  let proxy = 'socks5://api:1080';
  const tools = await createJavaApkTools(java, root, { resolveDefaultProxy: () => proxy });
  const identity = tools.networkIdentity(root);
  const worker = tools.worker('/fixture/source.jar', { entry: 'fixture', pkg: 'org.example.fixture' }, root);
  t.after(() => worker.close());
  for (const method of ['describe', 'list', 'detail', 'chapters', 'pages', 'image', 'cover', 'preferences'])
    assert.equal((await worker.request(method, { defaultProxy: 'http://spoofed:8080' })).defaultProxy, proxy);
  proxy = 'http://operator:8080';
  assert.notEqual(tools.networkIdentity(root), identity);
  assert.equal((await worker.request('list')).defaultProxy, proxy);
  const before = tools.networkIdentity(root);
  const key = Buffer.alloc(32, 7);
  await writeFile(join(root, 'preferences.key'), key, { mode: 0o600 });
  const writePreferences = async (network, sourceCache = '') => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const encoded = Buffer.from(
      JSON.stringify({ [createHash('sha256').update('moya.host.network').digest('hex')]: network, sourceCache }),
    );
    const body = Buffer.concat([cipher.update(encoded), cipher.final()]);
    await writeFile(join(root, 'preferences.enc'), Buffer.concat([Buffer.from([1]), iv, body, cipher.getAuthTag()]), {
      mode: 0o600,
    });
  };
  await writePreferences({ mode: 'inherit' }, 'changed source cache');
  assert.equal(tools.networkIdentity(root), before);
  await writePreferences({ mode: 'direct' });
  const direct = tools.networkIdentity(root);
  assert.notEqual(direct, before);
  proxy = 'socks5://api:1080';
  assert.equal(tools.networkIdentity(root), direct);
  await writePreferences({ mode: 'custom', proxy: 'socks5://override:1081' });
  const custom = tools.networkIdentity(root);
  assert.notEqual(custom, direct);
  proxy = 'http://operator:8080';
  assert.equal(tools.networkIdentity(root), custom);
  await writePreferences({ mode: 'inherit' });
  assert.equal(tools.networkIdentity(root), before);
  proxy = undefined;
  assert.equal((await worker.request('image')).defaultProxy, '');
});
