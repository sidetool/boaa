// Real Chromium regression: a fresh HTTP cache must not retain an old install identity.
// Run with node scripts/server-pwa-smoke.mjs (optional CHROMIUM_EXECUTABLE_PATH).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';

const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const icon = await readFile(new URL('../public/icons/boaa-192.png', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
let updated = false;
let offline = false;
let manifestRequests = 0;
const server = http.createServer((request, response) => {
  if (offline) return request.socket.destroy();
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.setHeader('Cache-Control', 'no-store');
    return response.end(worker);
  }
  if (pathname === '/manifest.webmanifest') {
    manifestRequests++;
    response.setHeader('Content-Type', 'application/manifest+json');
    response.setHeader('Cache-Control', updated ? 'no-cache' : 'public, max-age=3600');
    return response.end(
      JSON.stringify(updated ? manifest : { ...manifest, name: 'Legacy Reader', short_name: 'Legacy' }),
    );
  }
  if (pathname.startsWith('/icons/')) {
    response.setHeader('Content-Type', 'image/png');
    return response.end(icon);
  }
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Cache-Control', 'no-cache');
  response.end('<!doctype html><title>BOAA</title><link rel="manifest" href="/manifest.webmanifest">');
});

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const readManifest = () => page.evaluate(async () => (await (await fetch('/manifest.webmanifest')).json()).name);
  assert.equal(await readManifest(), 'Legacy Reader');
  updated = true;
  // Verify the fixture really has a stale HTTP entry, independently of CacheStorage.
  assert.equal(await readManifest(), 'Legacy Reader');
  await page.evaluate(async () => {
    localStorage.setItem('pwa-smoke-retained-setting', 'retained');
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  assert.equal(await readManifest(), manifest.name, 'worker install must refresh the HTTP cache');
  const before = manifestRequests;
  await readManifest();
  assert.ok(manifestRequests > before, 'online manifest requests must reach the server');
  await page.reload();
  const cdp = await page.context().newCDPSession(page);
  const install = await cdp.send('Page.getAppManifest');
  assert.deepEqual(install.errors, []);
  assert.equal(JSON.parse(install.data).name, manifest.name, 'Chrome install metadata must use the new name');
  assert.deepEqual(JSON.parse(install.data).icons, manifest.icons);
  offline = true;
  assert.equal(await readManifest(), manifest.name, 'offline fallback must retain the refreshed identity');
  assert.equal(await page.evaluate(() => localStorage.getItem('pwa-smoke-retained-setting')), 'retained');
  console.log(
    'PASS: stale HTTP manifest refreshed; Chromium install identity current; offline fallback and settings retained.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
