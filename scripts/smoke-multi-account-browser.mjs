/** Real isolated PG/Redis + buildServer + Vite + Chromium acceptance.
 * Run: env -i HOME="$HOME" PATH="$PATH" apps/server/node_modules/.bin/tsx scripts/smoke-multi-account-browser.mjs
 * Requires locally available postgres:16-alpine / redis:7-alpine and Chromium.
 * Never accepts an existing database. Artifacts contain only generated fixtures.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../apps/server/node_modules/pg/lib/index.js';
import { chromium } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { startPostgresIntegrationHarness } from '../apps/server/src/services/id-v2-migration/postgres-integration-harness.ts';
import { migrateDatabase } from '../apps/server/src/db/migrate.ts';
import { buildServer } from '../apps/server/src/server.ts';
import { testConfig } from '../apps/server/src/routes/books/books-route-test-harness.ts';
import { processImportJob } from '../apps/server/src/services/import-service.ts';

for (const name of Object.keys(process.env)) {
  if (/TEST_DATABASE_URL$|POSTGRES_TEST_URL/.test(name)) throw new Error(`Refusing external database setting: ${name}`);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(path.join(tmpdir(), 'boaa-browser-data-'));
const artifacts = await mkdtemp(path.join(tmpdir(), 'boaa-browser-evidence-'));
const redisName = `boaa-browser-${randomUUID().slice(0, 8)}`;
const events = [];
let harness,
  pool,
  app,
  vite,
  browser,
  redisStarted = false;
const passed = [];
const pass = (name) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
try {
  harness = await startPostgresIntegrationHarness();
  assert(harness && harness.source !== 'environment', 'Owned temporary PostgreSQL required');
  execFileSync(
    'docker',
    [
      'run',
      '--pull=never',
      '-d',
      '--name',
      redisName,
      '-p',
      '127.0.0.1::6379',
      'redis:7-alpine',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: 'pipe', timeout: 60000 },
  );
  redisStarted = true;
  const redisPort = execFileSync('docker', ['port', redisName, '6379/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1);
  pool = new pg.Pool({ connectionString: harness.url });
  await migrateDatabase(pool);
  const setupCode = randomUUID();
  const config = {
    ...testConfig(),
    defaultUserId: 'synthetic-owner',
    databaseUrl: harness.url,
    redisUrl: `redis://127.0.0.1:${redisPort}`,
    dataDir,
    objectStorageDir: path.join(dataDir, 'objects'),
    authToken: setupCode,
    maxChunkBytes: 1024 * 1024,
  };
  app = await buildServer(config);
  const backend = await app.listen({ host: '127.0.0.1', port: 0 });
  vite = await createViteServer({
    root: repo,
    define: {
      'import.meta.env.VITE_READER_BACKEND': JSON.stringify('remote'),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api'),
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: { '/api': { target: backend, changeOrigin: false } },
    },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.BOAA_CHROMIUM_PATH ??
      path.join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  async function pageFor(label) {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning')
        events.push({ page: label, type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) =>
      events.push({ page: label, type: 'pageerror', text: error.message, stack: error.stack }),
    );
    return page;
  }
  const ownerPage = await pageFor('owner');
  await ownerPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await ownerPage.getByLabel('아이디', { exact: true }).fill('owner');
  await ownerPage.getByPlaceholder('XXXX-XXXX-XXXX').fill(setupCode);
  await ownerPage.locator('input[autocomplete="new-password"]').nth(0).fill('synthetic owner passphrase');
  await ownerPage.locator('input[autocomplete="new-password"]').nth(1).fill('synthetic owner passphrase');
  await ownerPage
    .locator('form')
    .getByRole('button', { name: /계정|시작/ })
    .click();
  await ownerPage.getByRole('button', { name: '설정', exact: true }).first().waitFor();
  pass('actual UI original owner setup and authenticated runtime');
  async function api(page, url, { method = 'GET', body, sessionContext } = {}) {
    return page.evaluate(
      async ({ url, method, body, sessionContext }) => {
        const response = await fetch(url, {
          method,
          headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(sessionContext ? { 'X-BOAA-Session-Context': sessionContext } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      },
      { url, method, body, sessionContext },
    );
  }
  const owner = (await api(ownerPage, '/api/auth/status')).body;
  assert.equal(owner.account.role, 'admin');
  await ownerPage.getByRole('button', { name: '설정', exact: true }).first().click();
  await ownerPage.locator('#un-settings-tab-account').click();
  await ownerPage.getByRole('button', { name: '초대', exact: true }).click();
  await ownerPage.locator('#un-account-invite input').nth(0).fill('member');
  await ownerPage.locator('#un-account-invite input').nth(1).fill('Synthetic Member');
  await ownerPage.getByRole('button', { name: '초대 링크 만들기', exact: true }).click();
  const invitationUrl = await ownerPage.getByLabel('초대 링크', { exact: true }).inputValue();
  await ownerPage.screenshot({ path: path.join(artifacts, 'owner-invitation.png') });
  pass('actual admin UI creates invitation');
  const invited = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const memberPage = await invited.newPage();
  const memberProviderRequests = [];
  memberPage.on('request', (request) => {
    if (/\/api\/(?:ai|providers|tts)(?:\/|\?|$)/.test(request.url())) memberProviderRequests.push(request.url());
  });
  memberPage.setDefaultTimeout(30000);
  memberPage.on('pageerror', (error) =>
    events.push({ page: 'member', type: 'pageerror', text: error.message, stack: error.stack }),
  );
  await memberPage.goto(invitationUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await memberPage.locator('input[autocomplete="new-password"]').nth(0).fill('synthetic member passphrase');
  await memberPage.locator('input[autocomplete="new-password"]').nth(1).fill('synthetic member passphrase');
  await memberPage.locator('form button[type="submit"]').click();
  await memberPage.locator('input[autocomplete="username"]').waitFor();
  assert.equal(await memberPage.locator('input[autocomplete="username"]').inputValue(), 'member');
  assert.equal((await api(memberPage, '/api/auth/status')).body.authenticated, false);
  await memberPage.locator('input[autocomplete="current-password"]').fill('synthetic member passphrase');
  await memberPage.locator('form button[type="submit"]').click();
  await memberPage.getByRole('button', { name: '설정', exact: true }).first().waitFor();
  const member = (await api(memberPage, '/api/auth/status')).body;
  assert.equal(member.account.role, 'member');
  pass('actual invitation UI sets password, restores username, requires ordinary login');
  async function upload(page, account, title) {
    const text =
      `${title}\n\n` +
      Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: synthetic reading fixture for ${title}.`).join('\n\n');
    const initialized = await api(page, '/api/uploads/init', {
      method: 'POST',
      sessionContext: account.sessionContext,
      body: {
        fileName: `${title}.txt`,
        sizeBytes: Buffer.byteLength(text),
        contentType: 'text/plain',
        totalChunks: 1,
        encoding: 'utf-8',
      },
    });
    assert.equal(initialized.status, 200, JSON.stringify(initialized));
    const uploadId = initialized.body.uploadId;
    const chunkStatus = await page.evaluate(
      async ({ uploadId, text, context }) =>
        (
          await fetch(`/api/uploads/${uploadId}/chunks/0`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'X-BOAA-Session-Context': context },
            body: new TextEncoder().encode(text),
          })
        ).status,
      { uploadId, text, context: account.sessionContext },
    );
    assert.equal(chunkStatus, 200);
    const completed = await api(page, `/api/uploads/${uploadId}/complete`, {
      method: 'POST',
      sessionContext: account.sessionContext,
    });
    assert.equal(completed.status, 202, JSON.stringify(completed));
    // Execute the real import worker service against its persisted ownership/job/upload.
    await processImportJob(pool, config, completed.body.jobId, uploadId);
    const job = await api(page, `/api/import-jobs/${completed.body.jobId}`, { sessionContext: account.sessionContext });
    assert.equal(job.body.status, 'done', JSON.stringify(job));
    assert.equal(typeof job.body.book_id, 'string', JSON.stringify(job));
    return job.body.book_id;
  }
  const ownerBook = await upload(ownerPage, owner, 'Synthetic Owner Book');
  const memberBook = await upload(memberPage, member, 'Synthetic Member Book');
  assert(ownerBook && memberBook && ownerBook !== memberBook);
  assert.equal(
    (await api(memberPage, `/api/books/${ownerBook}/manifest`, { sessionContext: member.sessionContext })).status,
    404,
  );
  assert.equal(
    (await api(ownerPage, `/api/books/${memberBook}/manifest`, { sessionContext: owner.sessionContext })).status,
    404,
  );
  await ownerPage.reload({ waitUntil: 'domcontentloaded' });
  await memberPage.reload({ waitUntil: 'domcontentloaded' });
  await ownerPage.getByText('Synthetic Owner Book', { exact: true }).filter({ visible: true }).first().waitFor();
  await memberPage.getByText('Synthetic Member Book', { exact: true }).filter({ visible: true }).first().waitFor();
  assert.equal(await memberPage.getByText('Synthetic Owner Book', { exact: true }).count(), 0);
  assert.equal(await ownerPage.getByText('Synthetic Member Book', { exact: true }).count(), 0);
  await Promise.all([
    ownerPage.screenshot({ path: path.join(artifacts, 'owner-library.png') }),
    memberPage.screenshot({ path: path.join(artifacts, 'member-library.png') }),
  ]);
  pass('HTTP TXT uploads and real import service produce separate UI libraries');
  await memberPage.setViewportSize({ width: 390, height: 844 });
  await memberPage.getByRole('button', { name: '설정', exact: true }).first().click();
  await memberPage.locator('#un-settings-tab-account').click();
  await memberPage.getByRole('button', { name: '로그아웃', exact: true }).waitFor();
  assert.equal(await memberPage.locator('#un-settings-tab-server').count(), 0);
  assert.equal(await memberPage.getByRole('button', { name: '초대', exact: true }).count(), 0);
  await memberPage.emulateMedia({ reducedMotion: 'reduce' });
  await memberPage.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  assert(await memberPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(memberProviderRequests, [], 'Member UI must not probe administrator providers');
  await memberPage.screenshot({ path: path.join(artifacts, 'member-account-phone.png') });
  pass('phone account UI, member capability controls, no server provider probes');
  for (const url of ['/api/admin/accounts', '/api/source-network-settings', '/api/admin/system'])
    assert.equal((await api(memberPage, url, { sessionContext: member.sessionContext })).status, 403, url);
  pass('member global API denial');
  // Same-session revalidation must preserve the current form and runtime.
  await ownerPage.getByRole('button', { name: '설정', exact: true }).first().click();
  await ownerPage.locator('#un-settings-tab-account').click();
  await ownerPage.getByRole('button', { name: '초대', exact: true }).click();
  const draft = ownerPage.locator('#un-account-invite input').first();
  await draft.fill('unfinished-draft');
  await draft.evaluate((input) => {
    input.dataset.acceptanceMarker = 'same-node';
  });
  const revalidated = ownerPage.waitForResponse((response) => response.url().endsWith('/api/auth/status'));
  await ownerPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await revalidated;
  assert.equal(await draft.inputValue(), 'unfinished-draft');
  assert.equal(await draft.getAttribute('data-acceptance-marker'), 'same-node');
  pass('same-session focus preserves runtime and unfinished input');

  const secondTab = await pageFor('same-profile-second-tab');
  await secondTab.goto(origin, { waitUntil: 'domcontentloaded' });
  // Hold only the logout response: server revocation has already happened.
  let releaseLogout;
  const held = new Promise((resolve) => {
    releaseLogout = resolve;
  });
  let revoked;
  const revocationReached = new Promise((resolve) => {
    revoked = resolve;
  });
  await ownerPage.route('**/api/auth/logout', async (route) => {
    const response = await route.fetch();
    revoked();
    await held;
    await route.fulfill({ response });
  });
  const logout = ownerPage.evaluate(async (context) => {
    const { SelfHostAuthClient } = await import('/src/features/auth/self-host-auth-client.ts');
    await new SelfHostAuthClient('/api').logout(context);
  }, owner.sessionContext);
  await revocationReached;
  let loginReached = false;
  secondTab.on('request', (request) => {
    if (request.url().endsWith('/api/auth/login')) loginReached = true;
  });
  const login = secondTab.evaluate(async () => {
    const { SelfHostAuthClient } = await import('/src/features/auth/self-host-auth-client.ts');
    return new SelfHostAuthClient('/api').login({ username: 'member', password: 'synthetic member passphrase' });
  });
  // Explicit bounded observation of a held response, not a readiness sleep.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(loginReached, false, 'Cross-tab login must wait for the older cookie response');
  releaseLogout();
  await logout;
  assert.equal((await login).username, 'member');
  await ownerPage.unroute('**/api/auth/logout');
  const switched = (await api(secondTab, '/api/auth/status')).body;
  assert.equal(switched.account.username, 'member');
  const staleWrite = await api(ownerPage, `/api/books/${memberBook}`, {
    method: 'PATCH',
    sessionContext: owner.sessionContext,
    body: { title: 'STALE OWNER WRITE' },
  });
  assert.equal(staleWrite.status, 409);
  assert.equal(
    (await api(ownerPage, '/api/auth/logout', { method: 'POST', sessionContext: owner.sessionContext })).status,
    409,
  );
  assert.equal((await api(secondTab, '/api/auth/status')).body.account.username, 'member');
  await secondTab.reload({ waitUntil: 'domcontentloaded' });
  await secondTab.getByText('Synthetic Member Book', { exact: true }).filter({ visible: true }).first().waitFor();
  assert.equal(await secondTab.getByText('Synthetic Owner Book', { exact: true }).count(), 0);
  await secondTab.screenshot({ path: path.join(artifacts, 'same-profile-switched-library.png') });
  pass('two-tab cookie mutation serialization, stale write/logout rejection, switched UI library');

  await secondTab.getByRole('button', { name: '설정', exact: true }).first().click();
  await secondTab.locator('#un-settings-tab-account').click();
  await secondTab.getByRole('button', { name: '로그아웃', exact: true }).click();
  await secondTab.locator('input[autocomplete="username"]').waitFor();
  await secondTab.reload({ waitUntil: 'domcontentloaded' });
  await secondTab.locator('input[autocomplete="username"]').fill('owner');
  await secondTab.locator('input[autocomplete="current-password"]').fill('synthetic owner passphrase');
  await secondTab.locator('form button[type="submit"]').click();
  await secondTab.getByText('Synthetic Owner Book', { exact: true }).filter({ visible: true }).first().waitFor();
  assert.equal(await secondTab.getByText('Synthetic Member Book', { exact: true }).count(), 0);
  pass('UI logout survives reload and owner login restores only the original library');

  assert.deepEqual(
    events.filter((event) => event.type === 'pageerror'),
    [],
    'No uncaught browser errors',
  );
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ passed, events }, null, 2));
  console.log(`Artifacts: ${artifacts}`);
} catch (error) {
  if (browser)
    for (const [index, page] of browser
      .contexts()
      .flatMap((context) => context.pages())
      .entries()) {
      await page.screenshot({ path: path.join(artifacts, `failure-${index}.png`) }).catch(() => {});
      await writeFile(
        path.join(artifacts, `failure-${index}.txt`),
        await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      ).catch(() => {});
    }
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify({ passed, events, error: String(error) }, null, 2),
  );
  console.error(`Artifacts: ${artifacts}`);
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  await pool?.end();
  await harness?.stop();
  if (redisStarted) execFileSync('docker', ['rm', '-f', redisName], { stdio: 'pipe', timeout: 30000 });
  await rm(dataDir, { recursive: true, force: true });
}
