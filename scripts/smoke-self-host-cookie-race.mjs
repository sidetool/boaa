// Synthetic browser transport regression. No production server/data is used.
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { chromium } from 'playwright-core';
const source = await fs.readFile(new URL('../src/features/auth/self-host-session.ts', import.meta.url), 'utf8');
const mutationSource = await fs.readFile(
  new URL('../src/features/auth/self-host-auth-mutation.ts', import.meta.url),
  'utf8',
);
const mutationCode = ts.transpileModule(mutationSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const moduleCode = ts.transpileModule(
  source.replace(
    /import \{ SELF_HOST_AUTH_REQUIRED_EVENT \}[^;]+;/,
    "const SELF_HOST_AUTH_REQUIRED_EVENT = 'boaa:self-host-auth-required';",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const writes = [];

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/self-host-auth-mutation') {
    res.setHeader('Content-Type', 'application/javascript');
    return res.end(mutationCode);
  }
  if (req.url === '/session.js') {
    res.setHeader('Content-Type', 'application/javascript');
    return res.end(moduleCode);
  }
  if (req.url.startsWith('/test-login/')) {
    res.setHeader('Set-Cookie', `account=${req.url.split('/').pop()}; HttpOnly; SameSite=Lax; Path=/`);
    return res.end('{}');
  }
  if (req.url.startsWith('/api/')) {
    const account = /account=([ab])/.exec(req.headers.cookie ?? '')?.[1];
    if (req.headers['x-boaa-session-context'] !== `session-${account}`) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: 'session_context_mismatch' }));
    }
    if (req.url === '/api/write') writes.push(account);
    if (req.url === '/api/auth/logout') res.setHeader('Set-Cookie', 'account=; Max-Age=0; Path=/');
    return res.end(JSON.stringify({ account }));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Synthetic cookie race</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? '/home/koho5155/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const profile = await browser.newContext();
  const a = await profile.newPage(),
    b = await profile.newPage();
  await Promise.all([a.goto(origin), b.goto(origin)]);
  await a.evaluate(async () => {
    await fetch('/test-login/a');
    const { SelfHostSession } = await import('/session.js');
    window.oldSession = new SelfHostSession(
      {
        serverId: 'synthetic',
        account: { userId: 'a', username: 'a', displayName: 'A', role: 'member' },
        accountId: 'a',
        libraryId: 'library',
        sessionContext: 'session-a',
        capabilities: {},
        legacyDataOwner: false,
      },
      '/api',
    );
  });
  // No BroadcastChannel is installed: cookie replacement wins before A learns about it.
  await b.evaluate(() => fetch('/test-login/b'));
  const rejected = await a.evaluate(async () => {
    try {
      await window.oldSession.fetch('/api/write', { method: 'POST' });
      return false;
    } catch {
      return window.oldSession.signal.aborted;
    }
  });
  assert.equal(rejected, true);
  assert.deepEqual(writes, []);
  const staleLogout = await a.evaluate(
    async () =>
      (await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-BOAA-Session-Context': 'session-a' } })).status,
  );
  assert.equal(staleLogout, 409);
  const active = await b.evaluate(async () =>
    (await fetch('/api/current', { headers: { 'X-BOAA-Session-Context': 'session-b' } })).json(),
  );
  assert.equal(active.account, 'b');
  console.log('PASS: real shared cookies reject stale tab write; stale logout preserves B cookie.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
