import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserWorker } from './browser-worker.mjs';
import { seedApkPayload, writeApkManifest } from './apk-payload.mjs';

const token = 'a'.repeat(64);
async function start(options) {
  const worker = await createBrowserWorker({ token, ...options });
  worker.server.listen(0, '127.0.0.1');
  await once(worker.server, 'listening');
  const endpoint = `http://127.0.0.1:${worker.server.address().port}`;
  return { ...worker, endpoint, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
}

test('browser control authenticates health and constrains protocol, path, engine and arguments', async () => {
  const worker = await start({
    launch: () => {
      throw new Error('must not launch');
    },
  });
  try {
    assert.equal((await fetch(worker.endpoint + '/healthz')).status, 401);
    const manifest = await (await fetch(worker.endpoint + '/healthz', { headers: worker.headers })).json();
    assert.equal(manifest.component, 'browser');
    assert.equal(manifest.protocolVersion, 1);
    assert.equal((await fetch(worker.endpoint + '/other', { headers: worker.headers })).status, 404);
    for (const input of [
      { protocolVersion: 2, engine: 'chromium' },
      { protocolVersion: 1, engine: 'shell' },
      { protocolVersion: 1, engine: 'chromium', args: ['--proxy-server=unsafe'] },
      { protocolVersion: 1, engine: 'chromium', proxyBridge: { origins: ['file:///tmp/test'] } },
    ])
      assert.equal(
        (
          await fetch(worker.endpoint + '/v1/browsers', {
            method: 'POST',
            headers: worker.headers,
            body: JSON.stringify(input),
          })
        ).status,
        400,
      );
  } finally {
    await worker.close();
  }
});

test('unclaimed browser leases expire and release their process and proxy', async () => {
  let closed = 0,
    proxyClosed = 0;
  const browser = new EventEmitter();
  browser.close = async () => {
    closed++;
  };
  const worker = await start({
    launch: async () => browser,
    connectMs: 30,
    openProxy: async () => ({
      proxy: { server: 'http://127.0.0.1:1' },
      close: () => {
        proxyClosed++;
      },
    }),
  });
  try {
    const response = await fetch(worker.endpoint + '/v1/browsers', {
      method: 'POST',
      headers: worker.headers,
      body: JSON.stringify({ protocolVersion: 1, engine: 'chromium', proxyBridge: { origins: [] } }),
    });
    assert.equal(response.status, 201);
    await new Promise((done) => setTimeout(done, 70));
    assert.equal(closed, 1);
    assert.equal(proxyClosed, 1);
  } finally {
    await worker.close();
  }
});

test('cancelled browser launches cannot leave an orphan process', async () => {
  let release;
  let closed = 0;
  const launched = new Promise((done) => {
    release = done;
  });
  const worker = await start({ launch: () => launched, connectMs: 1000 });
  try {
    const controller = new AbortController();
    const request = fetch(worker.endpoint + '/v1/browsers', {
      method: 'POST',
      headers: worker.headers,
      signal: controller.signal,
      body: JSON.stringify({ protocolVersion: 1, engine: 'chromium' }),
    });
    await new Promise((done) => setTimeout(done, 20));
    controller.abort();
    await assert.rejects(request);
    await new Promise((done) => setTimeout(done, 20));
    release({
      close: async () => {
        closed++;
      },
    });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(closed, 1);
  } finally {
    await worker.close();
  }
});

test('APK payload activation is atomic, repeatable, and rejects symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-apk-payload-'));
  const source = join(root, 'source'),
    destination = join(root, 'volume');
  try {
    await mkdir(join(source, 'runtime/target'), { recursive: true });
    await mkdir(join(source, 'java/bin'), { recursive: true });
    await writeFile(join(source, 'runtime/build-inventory.json'), '{}');
    await writeFile(join(source, 'runtime/target/apk-worker-0.1.0.jar'), 'synthetic jar');
    await writeFile(join(source, 'java/release'), 'synthetic JRE');
    await writeFile(join(source, 'java/bin/java'), 'synthetic executable', { mode: 0o755 });
    await writeApkManifest(source);
    const first = await seedApkPayload(source, destination);
    const current = await readlink(join(destination, 'current'));
    await seedApkPayload(source, destination);
    assert.equal(await readlink(join(destination, 'current')), current);
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'current/manifest.json'), 'utf8')), first);
    await symlink('/etc/passwd', join(source, 'escape'));
    await assert.rejects(seedApkPayload(source, destination), /apk_payload_path_denied/);
    assert.equal(await readlink(join(destination, 'current')), current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
