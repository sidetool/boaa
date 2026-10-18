import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../apps/server/node_modules/playwright-core/index.mjs';

const root = path.resolve(process.env.BOAA_WEB_DIST || fileURLToPath(new URL('../dist', import.meta.url)));
let statusRequests = 0;
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/auth/status') {
    statusRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authenticated: false, setupRequired: false, setupCodeRequired: false }));
    return;
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BOAA_CHROMIUM_PATH ? { executablePath: process.env.BOAA_CHROMIUM_PATH } : {}),
  });
  for (const width of [390, 820]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const before = statusRequests;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor({ timeout: 10000 });
    assert.ok(statusRequests > before, 'Hosted web must request the same-origin auth API');
    assert.deepEqual(errors, [], 'Hosted startup must not throw');
    console.log(`PASS ${width}px: server auth requested and login screen rendered`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
