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
      { protocolVersion: 2, engine: 'camoufox' },
      { protocolVersion: 1, engine: 'shell' },
      { protocolVersion: 1, engine: 'camoufox', args: ['--proxy-server=unsafe'] },
      { protocolVersion: 1, engine: 'camoufox', proxyBridge: { origins: ['file:///tmp/test'] } },
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
      body: JSON.stringify({ protocolVersion: 1, engine: 'camoufox', proxyBridge: { origins: [] } }),
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
      body: JSON.stringify({ protocolVersion: 1, engine: 'camoufox' }),
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

test('one process slot includes cancelled launches and shutdown, with bounded cancellable waiting', async () => {
  let finishLaunch, finishClose;
  const launching = new Promise((resolve) => {
    finishLaunch = resolve;
  });
  const closing = new Promise((resolve) => {
    finishClose = resolve;
  });
  let launches = 0,
    closes = 0;
  const worker = await start({
    maxQueued: 1,
    launch: async () => {
      launches++;
      if (launches === 1) return launching;
      const browser = new EventEmitter();
      browser.close = async () => {};
      return browser;
    },
  });
  const state = async () => (await fetch(worker.endpoint + '/healthz', { headers: worker.headers })).json();
  const until = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('condition did not settle');
  };
  const request = (signal) =>
    fetch(worker.endpoint + '/v1/browsers', {
      method: 'POST',
      headers: worker.headers,
      signal,
      body: JSON.stringify({ protocolVersion: 1, engine: 'camoufox' }),
    });
  const first = new AbortController(),
    second = new AbortController();
  try {
    const one = request(first.signal);
    const rejectedOne = assert.rejects(one);
    await until(() => launches === 1);
    first.abort();
    await rejectedOne;
    const two = request(second.signal);
    const rejectedTwo = assert.rejects(two);
    await until(async () => (await state()).queued === 1);
    assert.equal((await request()).status, 503);
    second.abort();
    await rejectedTwo;
    await until(async () => (await state()).queued === 0);
    const three = request();
    await until(async () => (await state()).queued === 1);
    finishLaunch({
      close: async () => {
        closes++;
        await closing;
      },
    });
    await until(() => closes === 1);
    assert.equal(launches, 1, 'a closing process still owns the slot');
    assert.equal((await state()).running, 1);
    finishClose();
    assert.equal((await three).status, 201);
    assert.equal(launches, 2);
    assert.equal(closes, 1);
  } finally {
    first.abort();
    second.abort();
    finishLaunch({ close: async () => {} });
    finishClose();
    await worker.close();
  }
});

test('queued browser leases expire without launching another process', async () => {
  let launches = 0;
  const worker = await start({
    queueMs: 30,
    launch: async () => {
      launches++;
      const browser = new EventEmitter();
      browser.close = async () => {};
      return browser;
    },
  });
  const request = () =>
    fetch(worker.endpoint + '/v1/browsers', {
      method: 'POST',
      headers: worker.headers,
      body: JSON.stringify({ protocolVersion: 1, engine: 'camoufox' }),
    });
  try {
    assert.equal((await request()).status, 201);
    const queued = await request();
    assert.equal(queued.status, 503);
    assert.equal((await queued.json()).error, 'runtime_busy');
    assert.equal(launches, 1);
    const health = await (await fetch(worker.endpoint + '/healthz', { headers: worker.headers })).json();
    assert.equal(health.queued, 0);
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
