// Browser smoke for 서버 관리 and 기본 연결 방식: real pages, real HTTP client, mocked /api.
// Usage: node scripts/server-management-ui-smoke.mjs [--headed] [--screenshots-dir <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from './lib/temporary-loopback-port.mjs';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shotIndex = args.indexOf('--screenshots-dir');
const screenshotDir =
  shotIndex >= 0 && args[shotIndex + 1]
    ? path.resolve(args[shotIndex + 1])
    : path.join(os.tmpdir(), 'boaa-server-management-smoke');
const port = await findTemporaryLoopbackPort();
const baseUrl = `http://127.0.0.1:${port}`;
const pagePath = '/src/test/smoke/server-management.html';

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke assertion failed: ${message}`);
}

/** Screenshots only after every CSS animation has finished, e.g. the dialog layer's fade-in. */
async function settledScreenshot(page, options) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  await page.screenshot(options);
}

/** Fails when anything sticks out past the viewport; names the outermost offenders. */
async function assertNoHorizontalOverflow(page, label) {
  const report = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width) return undefined;
    const offenders = [...document.querySelectorAll('body *')]
      .filter((node) => node.getBoundingClientRect().right > width + 1)
      .filter((node) => !(node.parentElement && node.parentElement.getBoundingClientRect().right > width + 1))
      .slice(0, 5)
      .map(
        (node) =>
          `${node.tagName.toLowerCase()}.${[...node.classList].join('.')} → ${Math.round(node.getBoundingClientRect().right)}px`,
      );
    return `${document.documentElement.scrollWidth}px > ${width}px\n${offenders.join('\n')}`;
  });
  assert(!report, `${label} overflows horizontally: ${report}`);
}

async function waitForReachable(url, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Stateful stand-in for the API and updater: 202 acceptance, idle race, restarts and completion. */
function createMockServer(network) {
  const now = () => new Date().toISOString();
  const state = {
    status: {
      available: true,
      currentVersion: '0.1.1',
      channel: 'stable',
      phase: 'idle',
      busy: false,
      checkedAt: now(),
      release: {
        version: '0.2.0',
        publishedAt: now(),
        notes: '- 앱 안에서 서버 업데이트\n- 필요할 때 설치하는 실행 환경\n- ByeDPI 기본 연결',
        url: 'https://github.com/sidetool/boaa/releases',
      },
      operation: { id: 'old', action: 'check', startedAt: now(), completedAt: now() },
      components: [
        {
          id: 'apk',
          installed: false,
          enabled: false,
          running: false,
          supported: true,
          managed: true,
          downloadBytes: 188743680,
        },
        {
          id: 'browser',
          installed: true,
          enabled: true,
          running: false,
          supported: true,
          managed: true,
          version: '1.0.0',
          error: 'component_unavailable',
        },
        {
          id: 'metadata',
          installed: true,
          enabled: true,
          running: true,
          supported: true,
          managed: true,
          error: 'component_provider_missing',
        },
      ],
    },
    /** Queue of steps the updater plays on each GET after a request. */
    script: [],
    sequence: 0,
    network: network ?? {
      revision: 1,
      defaultProxy: '',
      defaultMode: 'direct',
      origin: 'direct',
      effectiveProxy: '',
      byedpi: { available: true, enabled: false, running: false },
    },
    /** While set, an enabled ByeDPI reports running:false so the panel keeps its health refresh going. */
    stallByedpi: false,
    puts: [],
    networkGets: 0,
    gets: 0,
  };

  function accept(request) {
    const id = `req-${++state.sequence}`;
    const operation = {
      id,
      action: request.action,
      componentId: request.componentId,
      enabled: request.enabled,
      startedAt: now(),
    };
    // Finished requests land in the persistent history the UI matches by id.
    const done = (patch) => (s) => {
      const completed = { ...operation, completedAt: now() };
      return {
        ...s,
        ...patch(s),
        busy: false,
        operation: completed,
        operationResults: [{ ...completed, outcome: 'complete' }, ...(s.operationResults ?? [])].slice(0, 32),
      };
    };
    // First GET after acceptance: still idle with the previous operation (pickup race).
    state.script.push((s) => s);
    if (request.action === 'component') {
      state.script.push((s) => ({ ...s, busy: true, phase: 'downloading', operation }));
      state.script.push('restart');
      state.script.push(
        done((s) => ({
          phase: 'complete',
          components: s.components.map((c) =>
            c.id === request.componentId
              ? {
                  ...c,
                  installed: c.installed || request.enabled,
                  enabled: request.enabled,
                  running: request.enabled,
                  version: '1.0.0',
                  error: undefined,
                }
              : c,
          ),
        })),
      );
    } else if (request.action === 'update') {
      for (const phase of ['downloading', 'preflight', 'backup', 'applying'])
        state.script.push((s) => ({ ...s, busy: true, phase, operation }));
      state.script.push('restart', 'restart');
      state.script.push(done(() => ({ phase: 'complete', currentVersion: '0.2.0', release: undefined })));
    } else if (request.action === 'channel') {
      state.script.push(done(() => ({ phase: 'idle', channel: request.channel })));
    } else {
      state.script.push((s) => ({ ...s, busy: true, phase: 'checking', operation }));
      state.script.push(done(() => ({ phase: 'idle', checkedAt: now() })));
    }
    return id;
  }

  return {
    state,
    async handle(route) {
      const request = route.request();
      const url = new URL(request.url());
      const json = (status, body) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/admin/system' && request.method() === 'GET') {
        state.gets += 1;
        const step = state.script.shift();
        if (step === 'restart') return route.abort('connectionrefused');
        if (step) state.status = step(state.status);
        return json(200, state.status);
      }
      if (url.pathname === '/api/admin/system/requests' && request.method() === 'POST') {
        return json(202, { accepted: true, id: accept(JSON.parse(request.postData() ?? '{}')) });
      }
      if (url.pathname === '/api/source-network-settings') {
        if (request.method() === 'PUT') {
          const body = JSON.parse(request.postData() ?? '{}');
          state.puts.push(body);
          if (body.revision !== state.network.revision) return json(409, { error: 'source_network_conflict' });
          const proxy = body.defaultProxy === null ? '' : body.defaultProxy;
          const mode = body.defaultMode ?? (body.byedpiEnabled ? 'byedpi' : proxy ? 'custom' : 'direct');
          const byedpi = mode === 'byedpi';
          state.network = {
            revision: state.network.revision + 1,
            defaultProxy: proxy,
            defaultMode: mode,
            origin: proxy ? 'settings' : 'direct',
            effectiveProxy: byedpi ? 'socks5://byedpi:1080' : mode === 'custom' ? proxy : '',
            byedpi: { available: true, enabled: byedpi, running: byedpi && !state.stallByedpi },
          };
        } else state.networkGets += 1;
        return json(200, state.network);
      }
      return json(404, { error: 'not_found' });
    },
  };
}

const vite = spawn(
  path.join('node_modules', '.bin', 'vite'),
  ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let viteLog = '';
vite.stdout.on('data', (chunk) => (viteLog += chunk));
vite.stderr.on('data', (chunk) => (viteLog += chunk));

let browser;
try {
  await waitForReachable(`${baseUrl}${pagePath}`, 60_000);
  await fs.mkdir(screenshotDir, { recursive: true });
  browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(message.text()))
      errors.push(message.text());
  });
  const mock = createMockServer();
  await page.route('**/api/**', (route) => mock.handle(route));
  await page.goto(`${baseUrl}${pagePath}`);
  const server = page.getByTestId('server');
  const network = page.getByTestId('network');

  await server.getByText('새 버전이 나왔어요').waitFor();
  await server.getByText('v0.2.0 변경 내역').waitFor();
  await server.getByText('설정 필요').waitFor();
  await server.getByText('받을 용량 180MB').waitFor();
  await settledScreenshot(page, { path: path.join(screenshotDir, 'server-overview.png'), fullPage: true });
  await assertNoHorizontalOverflow(page, 'overview');
  console.log('✓ release, change notes and runtime states render');

  // Install the APK runtime: 202 → idle race → active → API restart → completed by id.
  await server.getByRole('button', { name: '설치', exact: true }).click();
  const installDialog = page.getByRole('dialog');
  await installDialog.getByText('서버가 잠시 다시 시작돼').waitFor();
  await settledScreenshot(page, { path: path.join(screenshotDir, 'component-install-confirm.png') });
  const dialogOpacity = await page.evaluate(() => {
    const layer = document.querySelector('.un-layer');
    const sheet = document.querySelector('.un-sheet');
    return layer && sheet ? Number(getComputedStyle(layer).opacity) * Number(getComputedStyle(sheet).opacity) : 0;
  });
  assert(dialogOpacity === 1, `confirm dialog is fully opaque when captured (${dialogOpacity})`);
  await installDialog.getByRole('button', { name: '설치', exact: true }).click();
  await server.getByText('요청 보냄').waitFor();
  await server.getByText('설치 중').waitFor({ timeout: 10_000 });
  await server.getByText('서버가 잠시 다시 시작돼요').waitFor({ timeout: 15_000 });
  await server.getByText('APK 확장 실행기사용 중').waitFor({ timeout: 20_000 });
  assert((await server.getByText('서버가 잠시 다시 시작돼요').count()) === 0, 'reconnect notice clears');
  console.log('✓ component install: confirm → queued → running → restart → result by id');

  // A failing runtime that is switched on can be stopped, not only retried.
  const browserRow = server.locator('.un-server-component', { hasText: '브라우저 실행 환경' });
  await browserRow.getByText('실행기가 응답하지 않아요').waitFor();
  await browserRow.getByRole('button', { name: '다시 시도' }).waitFor();
  await browserRow.getByRole('button', { name: '중지', exact: true }).click();
  const stopDialog = page.getByRole('dialog');
  await stopDialog.getByText('서버가 잠시 다시 시작돼').waitFor();
  await stopDialog.getByRole('button', { name: '중지', exact: true }).click();
  await browserRow.getByText('중지됨').waitFor({ timeout: 20_000 });
  assert((await browserRow.getByText('실행기가 응답하지 않아요').count()) === 0, 'stopped runtime clears its error');
  console.log('✓ errored runtime stopped through confirm and restart');

  // Polling stops once nothing is happening.
  const idleGets = mock.state.gets;
  await page.waitForTimeout(3_000);
  assert(mock.state.gets === idleGets, `idle page keeps polling (${idleGets} → ${mock.state.gets})`);
  console.log('✓ no fast polling while idle (30s health refresh only)');

  // Channel change is not an install.
  await server.getByRole('radio', { name: /베타/ }).click();
  await server.locator('.un-server-channel.is-beta').waitFor({ timeout: 10_000 });
  console.log('✓ channel change applied');

  // Server update with confirmation, progress steps and restart.
  await server.getByRole('button', { name: '업데이트', exact: true }).click();
  await page.getByRole('dialog').getByText('v0.1.1 → v0.2.0').waitFor();
  await settledScreenshot(page, { path: path.join(screenshotDir, 'server-update-confirm.png') });
  await page.getByRole('dialog').getByRole('button', { name: '업데이트', exact: true }).click();
  await server.getByRole('list', { name: '업데이트 진행 단계' }).waitFor({ timeout: 10_000 });
  await settledScreenshot(page, { path: path.join(screenshotDir, 'server-update-progress.png'), fullPage: true });
  await assertNoHorizontalOverflow(page, 'server-update-progress');
  await server.getByText('서버를 다시 시작하는 중이에요').waitFor({ timeout: 15_000 });
  await server.getByText('v0.2.0 업데이트를 마쳤어요').waitFor({ timeout: 30_000 });
  await server.getByRole('button', { name: '새로 고침' }).waitFor();
  await settledScreenshot(page, { path: path.join(screenshotDir, 'server-updated.png'), fullPage: true });
  await assertNoHorizontalOverflow(page, 'server-updated');
  console.log('✓ update completes after reconnect and offers reload');

  // ByeDPI without typing an address. The mock keeps it "starting" so the panel's health refresh keeps running.
  mock.state.stallByedpi = true;
  await network.getByText('기본 연결 방식').click();
  await network.getByRole('radio', { name: /ByeDPI 우회/ }).click();
  await network.getByText('ByeDPI로 연결해요').waitFor();
  let put = mock.state.puts.at(-1);
  assert(put.byedpiEnabled === true && put.defaultMode === 'byedpi', 'ByeDPI PUT sends the explicit mode');
  await network.getByText('직접 연결로 바꾸지 않고').waitFor();
  console.log('✓ ByeDPI selected without an address; stalled start is explained');

  // Typing a custom proxy while health refreshes run must not lose the draft.
  await network.getByRole('radio', { name: /내 프록시/ }).click();
  const input = network.getByRole('textbox');
  await input.fill('socks5://typing.local:1080');
  const before = mock.state.networkGets;
  await page.waitForTimeout(11_000);
  assert(mock.state.networkGets >= before + 2, `health refresh ran (${before} → ${mock.state.networkGets})`);
  assert((await input.inputValue()) === 'socks5://typing.local:1080', 'draft address survives health refresh');
  assert(
    (await network.getByRole('radio', { name: /내 프록시/ }).getAttribute('aria-checked')) === 'true',
    'custom choice survives health refresh',
  );
  assert(await input.isEnabled(), 'input stays editable during health refresh');
  assert(await input.evaluate((node) => node === document.activeElement), 'input keeps focus during health refresh');
  mock.state.stallByedpi = false;
  await network.getByRole('button', { name: '저장', exact: true }).click();
  await network.getByText('저장했어요').waitFor();
  put = mock.state.puts.at(-1);
  assert(put.defaultMode === 'custom' && put.defaultProxy === 'socks5://typing.local:1080', 'custom save PUT');
  console.log('✓ custom draft survives ByeDPI health refresh, then saves');

  // 직접 연결 keeps the saved address on the server, so it can be picked again without typing.
  await network.getByRole('radio', { name: /직접 연결/ }).click();
  await network.getByText('직접 연결해요').waitFor();
  put = mock.state.puts.at(-1);
  assert(put.defaultMode === 'direct' && put.defaultProxy === 'socks5://typing.local:1080', 'direct keeps address');
  await network.getByText('저장한 주소: socks5://typing.local:1080').waitFor();
  await network.getByText('외부 Suwayomi 서버는').waitFor();
  await settledScreenshot(page, { path: path.join(screenshotDir, 'network.png'), fullPage: true });
  await assertNoHorizontalOverflow(page, 'network');
  console.log('✓ direct mode keeps the saved proxy');

  // The same editing regression on a touch phone, where a re-render that steals focus closes the keyboard.
  const phoneMock = createMockServer({
    revision: 1,
    defaultProxy: '',
    defaultMode: 'byedpi',
    origin: 'direct',
    effectiveProxy: 'socks5://byedpi:1080',
    byedpi: { available: true, enabled: true, running: false },
  });
  phoneMock.state.stallByedpi = true;
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  phone.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
  await phone.route('**/api/**', (route) => phoneMock.handle(route));
  await phone.goto(`${baseUrl}${pagePath}`);
  const phoneNetwork = phone.getByTestId('network');
  await phoneNetwork.getByText('기본 연결 방식').tap();
  await phoneNetwork.getByText('직접 연결로 바꾸지 않고').waitFor();
  await phoneNetwork.getByRole('radio', { name: /내 프록시/ }).tap();
  const phoneInput = phoneNetwork.getByRole('textbox');
  await phoneInput.tap();
  await phone.keyboard.type('socks5://phone.local:1080');
  const phoneBefore = phoneMock.state.networkGets;
  await phone.waitForTimeout(11_000);
  assert(phoneMock.state.networkGets >= phoneBefore + 2, 'phone: health refresh ran');
  assert((await phoneInput.inputValue()) === 'socks5://phone.local:1080', 'phone: draft survives');
  assert(
    (await phoneNetwork.getByRole('radio', { name: /내 프록시/ }).getAttribute('aria-checked')) === 'true',
    'phone: choice survives',
  );
  assert(await phoneInput.evaluate((node) => node === document.activeElement), 'phone: input keeps focus');
  await phone.keyboard.type('x');
  assert((await phoneInput.inputValue()) === 'socks5://phone.local:1080x', 'phone: typing continues after refresh');
  await settledScreenshot(phone, { path: path.join(screenshotDir, 'phone-network-editing.png'), fullPage: true });
  await assertNoHorizontalOverflow(phone, 'phone-network-editing');
  await phone.close();
  console.log('✓ phone: draft, choice and focus survive ByeDPI health refresh');

  // The same final state inside the real settings overlay at tablet and desktop widths.
  for (const [name, width, height] of [
    ['tablet-portrait', 820, 1180],
    ['tablet-landscape', 1180, 820],
  ]) {
    const shell = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await shell.route('**/api/**', (route) => mock.handle(route));
    await shell.goto(`${baseUrl}${pagePath}?shell`);
    await shell.getByTestId('server').getByText('최신 버전이에요').waitFor();
    await settledScreenshot(shell, { path: path.join(screenshotDir, `${name}.png`) });
    await assertNoHorizontalOverflow(shell, name);
    const inner = await shell.evaluate(() => {
      const content = document.querySelector('.un-settings-content');
      return content ? content.scrollWidth - content.clientWidth : -1;
    });
    assert(inner === 0, `${name}: settings content scrolls sideways (${inner}px)`);
    await shell.close();
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await settledScreenshot(page, { path: path.join(screenshotDir, 'phone.png'), fullPage: true });
  await assertNoHorizontalOverflow(page, 'phone');

  assert(errors.length === 0, `browser errors:\n${errors.join('\n')}`);
  console.log(`\nServer management UI smoke passed. Screenshots: ${screenshotDir}`);
} catch (error) {
  console.error(error);
  if (!/ready in/.test(viteLog)) console.error(viteLog);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill();
}
