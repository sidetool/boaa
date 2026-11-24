import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../apps/server/node_modules/playwright-core/index.mjs';

const root = path.resolve(process.env.BOAA_WEB_DIST || fileURLToPath(new URL('../dist', import.meta.url)));
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

const account = { userId: 'test-reader', username: 'reader', displayName: 'Reader', role: 'member' };
const credentials = { username: account.username, password: 'local startup smoke fixture' };
const sessionCookie = 'startup-session=reader';
const accountContext = {
  account,
  serverId: 'test',
  libraryId: 'library',
  accountId: 'member',
  sessionContext: 'session',
  capabilities: { useProviders: false },
};
const libraryResponses = new Map([
  ['/api/settings', { settings: {} }],
  ['/api/trash/books', { books: [] }],
  ['/api/shelves', { shelves: [], memberships: [] }],
  ['/api/discovery-settings', {}],
  ['/api/extensions/packages', { packages: [], sources: [], errors: [] }],
  [
    '/api/integration-settings',
    {
      settings: {
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        legacyImportCompleted: true,
        extensionEnablement: { schemaVersion: 1, enabledByExtensionId: {} },
        webNovelMetadata: { schemaVersion: 1, includeAdult: false, automaticLookup: false, automaticApply: 'off' },
        externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [] },
      },
    },
  ],
]);

async function checkStartup(page, origin) {
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Pause the browser clock during library bootstrap so the voice-discovery timeout cannot complete.
  await page.clock.install();
  await page.addInitScript(() => {
    const speech = new EventTarget();
    speech.cancel = () => {};
    window.boaaDeviceVoiceReads = 0;
    const failVoiceDiscovery = performance.getEntriesByType('navigation')[0]?.type === 'reload';
    speech.getVoices = () => {
      window.boaaDeviceVoiceReads++;
      if (failVoiceDiscovery) throw new Error('Device speech service unavailable');
      return [];
    };
    Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true });
    // Record even a loader that disappears before the library finishes opening.
    const plainLoader = /^서재(?:를)? (?:여는|불러오는) 중[.…]*$/;
    window.boaaPlainStartupShown = false;
    new MutationObserver((records) => {
      if (
        records.some((record) =>
          [record.target, ...record.addedNodes].some((node) => plainLoader.test(node.textContent?.trim() ?? '')),
        )
      ) {
        window.boaaPlainStartupShown = true;
      }
    }).observe(document, { childList: true, characterData: true, subtree: true });
  });

  let status = Promise.withResolvers();
  let books = Promise.withResolvers();
  let statusRequests = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/auth/status') {
      statusRequests++;
      await status.promise;
      const authenticated = (await request.headerValue('cookie'))?.split('; ').includes(sessionCookie) ?? false;
      return route.fulfill({
        json: {
          authenticated,
          setupRequired: false,
          setupCodeRequired: false,
          ...(authenticated ? { account, context: accountContext } : {}),
        },
      });
    }
    if (url.pathname === '/api/auth/login') {
      assert.equal(request.method(), 'POST');
      assert.deepEqual(request.postDataJSON(), credentials);
      return route.fulfill({
        headers: { 'Set-Cookie': `${sessionCookie}; Path=/; HttpOnly; SameSite=Lax` },
        json: { authenticated: true, account },
      });
    }
    if (url.pathname === '/api/books') {
      await books.promise;
      return route.fulfill({ json: { books: [], includesTrash: true } });
    }
    if (libraryResponses.has(url.pathname)) return route.fulfill({ json: libraryResponses.get(url.pathname) });
    if (/^\/assets\/reader-application-[^/]+\.js$/.test(url.pathname)) {
      // Make the old standalone reader loader observable on a local connection.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return route.continue();
  });

  async function checkAuthShell() {
    await page.getByRole('heading', { name: '서버에 연결하는 중', exact: true }).waitFor();
    const wall = page.locator('.un-auth-wall');
    assert.equal(await wall.evaluate((element) => getComputedStyle(element).position), 'fixed');
  }

  async function checkLibrary() {
    await checkAuthShell();
    await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
    status.resolve();
    const skeleton = page.locator('main.un-library[aria-busy="true"] .un-skeleton span').first();
    await skeleton.waitFor();
    assert.equal(await skeleton.evaluate((element) => getComputedStyle(element).display), 'block');
    books.resolve();
    await page.getByRole('heading', { name: '읽을 작품을 넣어 볼까요?', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.boaaDeviceVoiceReads > 0), 'Device voice discovery started');
    await page.clock.resume();
    assert.equal(await page.evaluate(() => window.boaaPlainStartupShown), false, 'A plain library loader appeared');
    assert.deepEqual(errors, [], 'Hosted startup must not throw');
  }

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await checkAuthShell();
    status.resolve();
    const signIn = page.getByRole('button', { name: '로그인', exact: true });
    await signIn.waitFor();
    assert.ok(statusRequests > 0, 'Hosted web must request the same-origin auth API');
    assert.deepEqual(errors, [], 'Hosted startup must not throw');

    status = Promise.withResolvers();
    await page.getByLabel('아이디', { exact: true }).fill(credentials.username);
    await page.getByLabel('비밀번호', { exact: true }).fill(credentials.password);
    await signIn.click();
    await checkLibrary();

    const beforeReload = statusRequests;
    status = Promise.withResolvers();
    books = Promise.withResolvers();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await checkLibrary();
    assert.ok(statusRequests > beforeReload, 'Reopening the library must check the same-origin session');
  } finally {
    status.resolve();
    books.resolve();
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BOAA_CHROMIUM_PATH ? { executablePath: process.env.BOAA_CHROMIUM_PATH } : {}),
  });
  for (const width of [390, 820]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
    });
    try {
      await checkStartup(await context.newPage(), origin);
      console.log(`PASS ${width}px: login and signed-in reload show the styled library startup`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
