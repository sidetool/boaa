import { openReaderActionSheet, openReaderLookTab, verifyReaderControls } from './desktop/verify-reader-controls.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium, devices, webkit } from 'playwright-core';
import { findTemporaryLoopbackPort } from './lib/temporary-loopback-port.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--');

function hasArg(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const externalBaseUrl = argValue('--url', process.env.READER_UI_SMOKE_URL ?? '');
const ownedPort = externalBaseUrl ? undefined : await findTemporaryLoopbackPort();
const baseUrl = externalBaseUrl || `http://127.0.0.1:${ownedPort}`;
const explicitChannel = argValue('--channel', process.env.READER_UI_BROWSER_CHANNEL ?? '');
const browserEngine = argValue('--browser', process.env.READER_UI_BROWSER_ENGINE ?? 'chromium');
const timeoutMs = Number(argValue('--timeout-ms', process.env.READER_UI_SMOKE_TIMEOUT_MS ?? '45000'));
const headed = hasArg('--headed');
const keepServer = hasArg('--keep-server');
const skipScreenshots = hasArg('--no-screenshots');
const initialContentOnly = hasArg('--initial-content-only');
const chapterBoundaryOnly = hasArg('--chapter-boundary-only');
const flowTransitionOnly = hasArg('--flow-transition-only');
const selectionControlsOnly = hasArg('--selection-controls-only');
const failedListeningOnly = hasArg('--failed-listening-only');
const narrowMobileViewport = hasArg('--narrow-mobile');
const mobileViewport = hasArg('--mobile') || narrowMobileViewport;
const tabletViewport = hasArg('--tablet');
const mobileSize = narrowMobileViewport ? { width: 320, height: 568 } : { width: 390, height: 844 };
const reducedMotion = hasArg('--reduced-motion') ? 'reduce' : undefined;
const novelFile = argValue('--novel-file', process.env.READER_UI_NOVEL_FILE ?? '');
let importedChapterCount = 0;
const screenshotDir = path.resolve(
  argValue('--screenshots-dir', process.env.READER_UI_SCREENSHOT_DIR ?? 'screenshots'),
);

function log(message) {
  console.log(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isReachable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReachable(url, deadlineMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (await isReachable(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startDevServer() {
  const commandArgs = ['exec', 'vite', '--host', '127.0.0.1', '--port', String(ownedPort), '--strictPort'];
  log(`\n$ pnpm ${commandArgs.join(' ')}`);
  const child = spawn('pnpm', commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopDevServer(server) {
  if (server.exitCode !== null || server.killed) return;
  if (process.platform !== 'win32') {
    server.kill('SIGTERM');
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

async function withServer(callback) {
  if (externalBaseUrl) {
    if (!(await isReachable(baseUrl))) {
      throw new Error(`The supplied Reader UI server is not reachable at ${baseUrl}`);
    }
    log(`Using existing dev server at ${baseUrl}`);
    return callback();
  }

  const server = startDevServer();
  try {
    await waitForReachable(baseUrl, timeoutMs);
    return await callback();
  } finally {
    if (keepServer) {
      log('Keeping dev server running.');
    } else {
      await stopDevServer(server);
    }
  }
}

async function launchBrowser() {
  if (browserEngine === 'webkit') {
    const browser = await webkit.launch({ headless: !headed });
    log('Using browser engine: webkit');
    return browser;
  }
  if (browserEngine !== 'chromium') throw new Error(`Unsupported reader UI browser engine: ${browserEngine}`);
  if (!explicitChannel && process.env.BOAA_CHROMIUM_PATH) {
    return chromium.launch({ executablePath: process.env.BOAA_CHROMIUM_PATH, headless: !headed });
  }
  const channels = explicitChannel ? [explicitChannel] : ['msedge', 'chrome', 'chromium'];
  const errors = [];
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ channel, headless: !headed });
      log(`Using browser channel: ${channel}`);
      return browser;
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(
    `Could not launch Edge/Chrome for reader UI smoke. Set READER_UI_BROWSER_CHANNEL or install a Playwright-compatible browser.\n${errors.join('\n')}`,
  );
}

async function dispatchTouch(target, session, type, clientY, clientX = 195) {
  if (session) {
    const nativeType = { touchstart: 'touchStart', touchmove: 'touchMove', touchend: 'touchEnd' }[type];
    await session.send('Input.dispatchTouchEvent', {
      type: nativeType,
      touchPoints: clientY === undefined ? [] : [{ x: clientX, y: clientY }],
    });
    return;
  }
  // WebKit has no DevTools touch input API.
  await target.evaluate(
    (element, input) => {
      const touches =
        input.clientY === undefined
          ? []
          : [{ identifier: 1, target: element, clientX: input.clientX, clientY: input.clientY }];
      const event = new Event(input.type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        targetTouches: { value: touches },
        changedTouches: { value: touches },
      });
      element.dispatchEvent(event);
    },
    { type, clientX, clientY },
  );
}

async function emulateSafariWithoutIdleCallback(context) {
  if (browserEngine !== 'webkit') return;
  await context.addInitScript(() => {
    Object.defineProperties(globalThis, {
      requestIdleCallback: { configurable: true, value: undefined },
      cancelIdleCallback: { configurable: true, value: undefined },
    });
  });
}

async function screenshot(page, name) {
  if (skipScreenshots) return;
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function assertVisible(page, selector, label) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  const box = await locator.boundingBox();
  if (!box || box.width < 1 || box.height < 1) throw new Error(`${label} is not visibly rendered`);
}

async function assertPointerReachable(locator, label) {
  const reachability = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { reachable: element.contains(target), coveringElement: target?.outerHTML.slice(0, 160) };
  });
  if (!reachability.reachable) {
    throw new Error(`${label} is covered at its center: ${JSON.stringify(reachability)}`);
  }
}

async function assertNoHorizontalOverflow(page, label, failures) {
  const issues = await page.evaluate(() => {
    const selectors = [
      '.reader-topbar',
      '.reader-bottombar',
      '.reader-document',
      '.reader-scroll',
      '.un-settings-bar',
      '.un-settings-content',
      '.addon-panel',
      '.search-result-strip',
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const overflowsViewport = rect.left < -2 || rect.right > viewportWidth + 2;
          const overflowsSelf = element.scrollWidth > element.clientWidth + 2;
          return overflowsViewport || overflowsSelf
            ? {
                selector,
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                viewportWidth,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
              }
            : undefined;
        })
        .filter(Boolean),
    );
  });
  if (issues.length) {
    const message = `${label} has horizontal overflow: ${JSON.stringify(issues.slice(0, 5))}`;
    if (!failures) throw new Error(message);
    failures.push(message);
    log(message);
  }
}

async function assertReaderDomIsBounded(page) {
  const counts = await page.evaluate(() => {
    const active = document.querySelector('.reader-viewport-layer.is-active');
    return {
      paragraphs: active?.querySelectorAll('.reader-paragraph').length ?? 0,
      rows: active?.querySelectorAll('.reader-virtual-row').length ?? 0,
    };
  });
  if (counts.paragraphs < 1) throw new Error('Reader rendered no visible paragraphs');
  if (counts.rows > 45 || counts.paragraphs > 45) {
    throw new Error(`Reader rendered too many virtual rows: ${JSON.stringify(counts)}`);
  }
}

async function waitForReaderTextWithoutInput(page) {
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll('.reader-viewport-layer.is-active .reader-paragraph:not(.is-loading):not(.is-error)'),
      ).some((row) => row instanceof HTMLElement && row.checkVisibility() && row.innerText.trim().length > 0),
    undefined,
    { timeout: timeoutMs },
  );
}

async function revealReaderChrome(page) {
  const screen = page.locator('.reader-screen');
  if ((await screen.getAttribute('class'))?.split(/\s+/u).includes('chrome-visible')) return;
  const viewport = page.locator('.reader-viewport-layer.is-active');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Reader viewport is unavailable for the center control toggle');
  await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.locator('.reader-screen.chrome-visible').waitFor({ state: 'visible', timeout: timeoutMs });
}

async function openReaderLookFromQuickView(page) {
  await revealReaderChrome(page);
  await page.getByRole('button', { name: '보기 설정 열기', exact: true }).click();
  const quickView = page.getByRole('dialog', { name: '보기', exact: true });
  await quickView.getByRole('button', { name: '전체 설정', exact: true }).click();
  return openReaderLookTab(page);
}

async function setReadingMode(page, name) {
  const settings = await openReaderLookFromQuickView(page);
  const modes = settings.getByRole('radiogroup', { name: '읽기 방식', exact: true });
  await modes.getByRole('radio', { name, exact: true }).click();
  await modes.getByRole('radio', { name, exact: true, checked: true }).waitFor();
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
}

async function openReaderTools(page) {
  await revealReaderChrome(page);
  const actions = await openReaderActionSheet(page);
  await actions.getByRole('button', { name: '부가 기능', exact: true }).click();
  return page.getByRole('dialog').filter({ has: page.getByRole('tablist', { name: '읽기 도구 분류' }) });
}

async function openListeningTab(tools) {
  await tools.getByRole('tab', { name: '듣기', exact: true }).click();
  const playback = tools.getByRole('region', { name: '재생', exact: true });
  await playback.getByRole('button', { name: '재생', exact: true }).waitFor();
  return playback;
}

async function readerFrameSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.reader-viewport-layer.is-active');
    const documentElement = root?.querySelector('.reader-document');
    const firstParagraph = root?.querySelector('[data-paragraph-id]');
    if (!(root instanceof HTMLElement) || !(documentElement instanceof HTMLElement)) return { missing: true };
    const style = getComputedStyle(root);
    const documentRect = documentElement.getBoundingClientRect();
    const paragraphRect = firstParagraph?.getBoundingClientRect();
    return {
      missing: false,
      rootWidth: root.clientWidth,
      rootHeight: root.clientHeight,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      documentLeft: Math.round(documentRect.left * 10) / 10,
      documentWidth: Math.round(documentRect.width * 10) / 10,
      firstParagraphTop: paragraphRect ? Math.round(paragraphRect.top * 10) / 10 : undefined,
    };
  });
}

async function assertChromeOverlayKeepsReaderFrame(page) {
  const initial = await readerFrameSnapshot(page);
  if (initial.missing) throw new Error('Reader frame was unavailable before showing controls');
  await revealReaderChrome(page);
  await page.waitForTimeout(220);
  const visible = await readerFrameSnapshot(page);
  if (JSON.stringify(visible) !== JSON.stringify(initial)) {
    throw new Error(`Reader controls changed the reading frame: ${JSON.stringify({ initial, visible })}`);
  }
  const viewport = page.locator('.reader-viewport-layer.is-active');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Reader viewport is unavailable for the center control toggle');
  await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.locator('.reader-screen.immersive').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForTimeout(220);
  const hiddenAgain = await readerFrameSnapshot(page);
  if (JSON.stringify(hiddenAgain) !== JSON.stringify(initial)) {
    throw new Error(`Hiding Reader controls changed the reading frame: ${JSON.stringify({ initial, hiddenAgain })}`);
  }
}

async function paginatedFrameSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.reader-paginated-root.is-active');
    const stage = root?.querySelector('.reader-pagination-stage');
    const current = root?.querySelector('.reader-paginated-page.is-current');
    const firstFragment = current?.querySelector('[data-paragraph-id], [data-reader-chapter-heading]');
    if (!(root instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(current instanceof HTMLElement)) {
      return { missing: true };
    }
    const rootStyle = getComputedStyle(root);
    const stageRect = stage.getBoundingClientRect();
    const fragmentRect = firstFragment?.getBoundingClientRect();
    return {
      missing: false,
      rootWidth: root.clientWidth,
      rootHeight: root.clientHeight,
      paddingTop: rootStyle.paddingTop,
      paddingBottom: rootStyle.paddingBottom,
      stageTop: Math.round(stageRect.top * 10) / 10,
      stageLeft: Math.round(stageRect.left * 10) / 10,
      stageWidth: Math.round(stageRect.width * 10) / 10,
      stageHeight: Math.round(stageRect.height * 10) / 10,
      firstFragmentTop: fragmentRect ? Math.round(fragmentRect.top * 10) / 10 : undefined,
      startIndex: current.getAttribute('data-page-start-index'),
      startOffset: current.getAttribute('data-page-start-offset'),
    };
  });
}

async function assertPaginatedChromeOverlayKeepsReaderFrame(page) {
  await page.keyboard.press('PageDown');
  await page.locator('.reader-paginated-page.is-current').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForTimeout(220);
  const initial = await paginatedFrameSnapshot(page);
  if (initial.missing) throw new Error('Paginated Reader frame was unavailable before showing controls');
  await revealReaderChrome(page);
  await page.waitForTimeout(220);
  const visible = await paginatedFrameSnapshot(page);
  if (JSON.stringify(visible) !== JSON.stringify(initial)) {
    throw new Error(`Reader controls changed the paginated frame: ${JSON.stringify({ initial, visible })}`);
  }
  const viewport = page.locator('.reader-viewport-layer.is-active');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('Paginated Reader viewport is unavailable for the center control toggle');
  await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.locator('.reader-screen.immersive').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForTimeout(220);
  const hiddenAgain = await paginatedFrameSnapshot(page);
  if (JSON.stringify(hiddenAgain) !== JSON.stringify(initial)) {
    throw new Error(`Hiding Reader controls changed the paginated frame: ${JSON.stringify({ initial, hiddenAgain })}`);
  }
}

async function openSampleReader(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByRole('button', { name: '서재', exact: true }).click({ timeout: timeoutMs });
  await page.getByRole('button', { name: '샘플 작품 넣어 보기', exact: true }).click({ timeout: timeoutMs });
  await page.getByRole('list', { name: '샘플: 돌아온 밤 회차 목록' }).waitFor({ timeout: timeoutMs });
  await page.getByRole('button', { name: '첫 화 보기', exact: true }).click({ timeout: timeoutMs });
  await waitForReaderTextWithoutInput(page);
}

async function openImportedNovelReader(page, file) {
  if (typeof file === 'string') await fs.access(file);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByRole('button', { name: '파일 가져오기', exact: true }).click({ timeout: timeoutMs });
  const importer = page.getByRole('dialog', { name: '책 가져오기', exact: true });
  await importer.locator('input[type="file"]').setInputFiles(file);
  await importer.getByRole('button', { name: '가져오기', exact: true }).click({ timeout: timeoutMs });
  const continueReading = page.getByRole('button', { name: /첫 화 보기|이어 읽기/ }).first();
  await continueReading.waitFor({
    state: 'visible',
    timeout: typeof file === 'string' ? Math.max(timeoutMs, 120_000) : timeoutMs,
  });
  if (typeof file === 'string') {
    const chapterCandidates = page.getByRole('list', { name: /회차 목록$/u }).locator('button.un-chapter-open');
    await chapterCandidates.first().waitFor();
    const chapterSizes = (await chapterCandidates.locator('small').allTextContents()).map((text) =>
      Number((text.match(/([\d,]+)자/u)?.[1] ?? '0').replaceAll(',', '')),
    );
    importedChapterCount = chapterSizes.length;
    const largestChapter = chapterSizes.indexOf(Math.max(...chapterSizes));
    if (chapterSizes[largestChapter] > 0) {
      await chapterCandidates.nth(largestChapter).click();
    } else {
      await continueReading.click();
    }
  } else {
    await continueReading.click();
  }
  await waitForReaderTextWithoutInput(page);
}

async function openReader(page) {
  if (novelFile) {
    log(`Testing real novel: ${path.basename(novelFile)}`);
    await openImportedNovelReader(page, path.resolve(novelFile));
    return;
  }
  await openSampleReader(page);
}

async function assertFailedListeningStart(browser) {
  log('Checking failed listening from an imported TXT file');
  const viewport = mobileViewport ? mobileSize : { width: 1440, height: 960 };
  const contextOptions = { viewport, hasTouch: mobileViewport, reducedMotion };
  // Playwright removes the temporary profile on close. WebKit needs it for IndexedDB Blob writes.
  const context =
    browserEngine === 'webkit'
      ? await webkit.launchPersistentContext('', { ...contextOptions, headless: !headed })
      : await browser.newContext(contextOptions);
  try {
    await context.addInitScript(() => {
      const speech = { available: false, utterance: null };
      window.readerSmokeSpeech = speech;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        get: () =>
          speech.available
            ? {
                getVoices: () => [{ voiceURI: 'smoke-ko', name: 'Smoke voice', lang: 'ko-KR' }],
                cancel() {},
                speak(utterance) {
                  speech.utterance = utterance;
                },
              }
            : undefined,
      });
      window.SpeechSynthesisUtterance = class {
        constructor(text) {
          this.text = text;
        }
      };
    });
    const page = await context.newPage();
    await openImportedNovelReader(page, {
      name: 'listening-smoke.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('제 1화 낭독 검사\n\n테스트 본문을 한 문장씩 읽습니다.\n\n첫 요청 뒤에 다시 시도합니다.'),
    });
    log('Opened the TXT fixture in the reader');
    await revealReaderChrome(page);
    const toolbar = page.getByRole('toolbar', { name: '리더 도구' });
    const start = toolbar.getByRole('button', { name: '듣기 시작', exact: true });
    await start.click();
    await page
      .getByRole('status')
      .filter({ hasText: '이 환경에서는 시스템 TTS를 사용할 수 없습니다.' })
      .waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await start.getAttribute('aria-pressed')) !== 'false') {
      throw new Error('Unavailable system speech left TXT listening active');
    }

    await page.evaluate(() => {
      window.readerSmokeSpeech.available = true;
    });
    await start.click();
    await page.waitForFunction(() => Boolean(window.readerSmokeSpeech.utterance), undefined, { timeout: timeoutMs });
    await toolbar.getByText('준비 중', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.evaluate(() => {
      const speech = window.readerSmokeSpeech;
      speech.utterance.onerror({ error: 'network' });
      speech.utterance = null;
    });
    await page
      .getByRole('alert')
      .filter({ hasText: '시스템 음성 데이터를 불러오지 못했습니다.' })
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await start.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await start.getAttribute('aria-pressed')) !== 'false') {
      throw new Error('System speech failure left TXT listening active');
    }
    await page.getByRole('button', { name: 'TTS 재생', exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
    await start.click();
    await page.waitForFunction(() => Boolean(window.readerSmokeSpeech.utterance), undefined, { timeout: timeoutMs });
    await page.evaluate(() => window.readerSmokeSpeech.utterance.onstart());
    await toolbar.getByText('듣는 중', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.evaluate(() => {
      window.readerSmokeSpeech.narration = window.readerSmokeSpeech.utterance;
    });
    const follow = page.getByRole('button', { name: '현재 듣는 위치로' });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('End');
    await follow.click();
    const slider = page.getByRole('slider', { name: '읽기 진행률' });
    await slider.fill('400');
    await follow.click();
    const playingTool = toolbar.getByRole('button', { name: '현재 듣기 패널 열기' });
    await playingTool.focus();
    await page.keyboard.press('ArrowRight');
    await follow.waitFor();
    await follow.click();
    await playingTool.click();
    const timer = page.getByRole('radiogroup', { name: '이번 재생 수면 타이머' });
    await timer.getByRole('radio', { name: '20분' }).click();
    await timer.getByRole('radio', { name: '20분', checked: true }).waitFor();
    await page.getByRole('button', { name: '읽기 도구 닫기' }).click();
    const mini = page.getByRole('region', { name: 'TTS 재생 제어' });
    if (mobileViewport) {
      const countdown = mini.getByText(/^\d{1,2}:\d{2}$/u);
      await countdown.waitFor();
      const clipped = await countdown.evaluate((element) => {
        const right = element.getBoundingClientRect().right;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (getComputedStyle(ancestor).overflowX !== 'visible' && right > ancestor.getBoundingClientRect().right + 1)
            return true;
          if (ancestor.matches('.tts-compact-bar')) break;
        }
        return false;
      });
      if (clipped) throw new Error('The current sleep timer is clipped in the mobile mini player');
    }
    const quote = await page.locator('.reader-viewport-layer.is-active').evaluate((element) => {
      for (const run of element.querySelectorAll('[data-reader-text]')) {
        const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent.length < 5) continue;
          window.getSelection().setBaseAndExtent(node, 1, node, 4);
          return node.textContent.slice(1, 4);
        }
      }
      throw new Error('No selectable text in the TXT fixture');
    });
    const preview = page.getByRole('button', { name: '선택 문장 듣기', exact: true });
    if (mobileViewport) {
      await page.locator('.toast-region .toast').first().waitFor({ state: 'hidden' });
      await preview.waitFor();
      await assertPointerReachable(preview, 'Selection listening button');
      await assertPointerReachable(mini.getByRole('button', { name: 'TTS 일시정지' }), 'Mini player pause button');
    }
    page.once('dialog', (confirmation) => confirmation.dismiss());
    await preview.click();
    if (!(await page.evaluate(() => window.readerSmokeSpeech.narration === window.readerSmokeSpeech.utterance)))
      throw new Error('Opening the player or cancelling a preview restarted the narration');
    page.once('dialog', (confirmation) => confirmation.accept());
    await preview.click();
    await page.waitForFunction((expected) => window.readerSmokeSpeech.utterance?.text === expected, quote);
    await page.getByRole('button', { name: '선택 문장 듣기 정지' }).click();
    await preview.waitFor();
    await page.getByRole('button', { name: '발음 고치기', exact: true }).click();
    await page.getByRole('heading', { name: '발음·문자 필터' }).waitFor();
    log(
      'TXT recovers from failed starts, preserves the active session from the footer and previews only the selected text.',
    );
  } finally {
    await context.close();
  }
}

async function assertPaginatedPageFitsViewport(page, label) {
  const layout = await page.evaluate(() => {
    const root = document.querySelector('.reader-paginated-root.is-active');
    const stage = root?.querySelector('.reader-pagination-stage');
    const pageElement = root?.querySelector('.reader-paginated-page.is-current');
    if (!(root instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(pageElement instanceof HTMLElement)) {
      return { missing: true };
    }
    const rootRect = root.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const blocks = [...pageElement.querySelectorAll('[data-reader-chapter-heading], [data-paragraph-id]')].map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute('data-paragraph-id') ?? 'chapter-heading',
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          text: element.textContent?.trim().slice(0, 40),
        };
      },
    );
    const clippedBlocks = blocks.filter(
      (block) => block.top < stageRect.top - 1 || block.bottom > stageRect.bottom + 1,
    );
    const contentBottom = blocks.reduce((bottom, block) => Math.max(bottom, block.bottom), Math.round(stageRect.top));
    return {
      missing: false,
      ready: pageElement.hasAttribute('data-page-start-index') && blocks.length > 0,
      rootHeight: rootRect.height,
      stageHeight: stageRect.height,
      stageTop: Math.round(stageRect.top),
      stageBottom: Math.round(stageRect.bottom),
      clipped: clippedBlocks.length > 0,
      clippedBlocks,
      contentFillRatio: stageRect.height > 0 ? (contentBottom - stageRect.top) / stageRect.height : 0,
    };
  });
  if (layout.missing || !layout.ready || layout.clipped || layout.stageHeight < layout.rootHeight * 0.55) {
    throw new Error(`${label} has a clipped or undersized page stage: ${JSON.stringify(layout)}`);
  }
  return layout;
}

async function waitForPaginatedPageFit(page, label, maxWaitMs = 1_500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      await assertPaginatedPageFitsViewport(page, label);
      const elapsed = Date.now() - startedAt;
      log(`${label} layout settled in ${elapsed}ms`);
      return elapsed;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(25);
    }
  }
  throw lastError;
}

async function currentPageStart(page) {
  return page
    .locator(
      '.reader-paginated-root.is-active[data-pagination-ready="true"] ' +
        '.reader-paginated-page.is-current[data-page-start-index][data-page-start-offset]',
    )
    .evaluate((element) => ({
      index: Number(element.getAttribute('data-page-start-index')),
      offset: Number(element.getAttribute('data-page-start-offset')),
    }));
}

async function wheelOverPage(page, deltaY) {
  const box = await page.locator('.reader-paginated-root.is-active').boundingBox();
  if (!box) throw new Error('Paginated reader viewport is unavailable for wheel input');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function assertChapterHeading(page, label) {
  const heading = page.locator('.reader-paginated-page.is-current [data-reader-chapter-heading]');
  await heading.waitFor({ state: 'visible', timeout: timeoutMs });
  const content = (await heading.innerText()).trim();
  if (!/^제\s+\d+화/mu.test(content) || !(await heading.locator('h1').innerText()).trim()) {
    throw new Error(`${label} does not show both the chapter sequence and title: ${JSON.stringify(content)}`);
  }
}

async function waitForChapterStart(page, expectedTitle) {
  await page.waitForFunction(
    (title) => {
      const root = document.querySelector('[data-reader-layer="scroll"].is-active');
      const progress = document.querySelector('input[aria-label="읽기 진행률"]');
      return (
        document.querySelector('.un-reader-title strong')?.textContent === title &&
        root?.getAttribute('aria-busy') === 'false' &&
        root.querySelector('[data-reader-chapter-heading]') &&
        root.scrollTop <= 1 &&
        progress?.value === '0'
      );
    },
    expectedTitle,
    { timeout: timeoutMs },
  );
}

async function assertScrollChapterBoundary(browser) {
  log('Checking deliberate scroll-end next-chapter gesture');
  const context = await browser.newContext({
    ...(browserEngine === 'webkit' ? devices['iPad Pro 11'] : {}),
    viewport: { width: 1280, height: 720 },
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await emulateSafariWithoutIdleCallback(context);
  const page = await context.newPage();
  try {
    await openSampleReader(page);
    const root = page.locator('[data-reader-layer="scroll"].is-active');
    const currentTitle = page.locator('.un-reader-title strong');
    const titleBefore = await currentTitle.textContent();
    const nextTitle = root.locator('.reader-chapter-end-next strong');
    const wheelDestination = await nextTitle.textContent();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await root.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(120);
    if ((await currentTitle.textContent()) !== titleBefore) {
      throw new Error('Reaching the scroll end immediately changed chapter');
    }
    const boundary = page.locator('[data-scroll-chapter-boundary="true"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
        'true',
      undefined,
      { timeout: 1_500 },
    );
    log('Scroll chapter boundary armed for wheel input');
    const weakPull = await root.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, deltaMode: 0, bubbles: true, cancelable: true }));
      const content = element.querySelector('.reader-document');
      return {
        className: content.className,
        transform: getComputedStyle(content).transform,
        offset: Number.parseFloat(content.style.getPropertyValue('--reader-boundary-pull')),
      };
    });
    if (!weakPull.className.includes('is-wheel-pull') || weakPull.transform === 'none' || !(weakPull.offset > 0)) {
      throw new Error(`A weak boundary wheel did not move the end content: ${JSON.stringify(weakPull)}`);
    }
    await page.waitForTimeout(90);
    if ((await currentTitle.textContent()) !== titleBefore) {
      throw new Error('A weak boundary wheel changed chapter');
    }
    if ((await boundary.getAttribute('data-scroll-chapter-boundary-armed')) !== 'true') {
      throw new Error('A weak boundary wheel unexpectedly disarmed the next-chapter gesture');
    }
    await page.waitForTimeout(320);
    const releasedPull = await root
      .locator('.reader-document')
      .evaluate((element) => getComputedStyle(element).transform);
    if (releasedPull !== 'none' && releasedPull !== 'matrix(1, 0, 0, 1, 0, 0)') {
      throw new Error(`A weak boundary wheel did not spring back: ${JSON.stringify(releasedPull)}`);
    }
    log('Weak wheel pull released without changing chapter');
    await root.dispatchEvent('wheel', { deltaY: 100, deltaMode: 0 });
    log('Strong wheel input dispatched');
    await waitForChapterStart(page, wheelDestination);
    log('Strong wheel input opened the next chapter at its start');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const secondRoot = page.locator('[data-reader-layer="scroll"].is-active');
    const touchSession = browserEngine === 'chromium' ? await context.newCDPSession(page) : undefined;
    const touchDestination = await nextTitle.textContent();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await secondRoot.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
    }
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
        'true',
      undefined,
      { timeout: 1_500 },
    );
    log('Scroll chapter boundary armed for touch input');
    await dispatchTouch(secondRoot, touchSession, 'touchstart', 420);
    await dispatchTouch(secondRoot, touchSession, 'touchmove', 390);
    await dispatchTouch(secondRoot, touchSession, 'touchend');
    await page.waitForTimeout(220);
    const titleAfterWeakTouch = await currentTitle.textContent();
    if (titleAfterWeakTouch !== wheelDestination) {
      throw new Error(`A weak boundary touch changed chapter from '${wheelDestination}' to '${titleAfterWeakTouch}'`);
    }
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
        'true',
      undefined,
      { timeout: 1_500 },
    );
    log('Weak touch pull released without changing chapter');
    await secondRoot.evaluate((element) => {
      element.scrollTop -= 48;
    });
    await page.locator('[data-scroll-chapter-boundary-armed="false"]').waitFor({ state: 'attached', timeout: 1_500 });
    const nextButton = secondRoot.locator('button.reader-chapter-end-next');
    const touchStart = await nextButton.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Next-chapter button is covered');
      return { x, y };
    });
    await dispatchTouch(nextButton, touchSession, 'touchstart', touchStart.y, touchStart.x);
    await dispatchTouch(nextButton, touchSession, 'touchmove', touchStart.y - 80, touchStart.x);
    await page.waitForTimeout(40);
    const touchPull = await secondRoot.locator('.reader-document').evaluate((element) => ({
      className: element.className,
      transform: getComputedStyle(element).transform,
    }));
    if (!touchPull.className.includes('is-touch-pull') || touchPull.transform === 'none') {
      throw new Error(`Touch boundary gesture did not follow the pointer: ${JSON.stringify(touchPull)}`);
    }
    await dispatchTouch(nextButton, touchSession, 'touchend');
    log('Strong touch input dispatched from the next-title button');
    await waitForChapterStart(page, touchDestination);
    log('Strong touch input opened the next chapter at its start');
  } finally {
    await context.close();
  }
}

async function runReaderSmoke() {
  const browser = await launchBrowser();
  if (chapterBoundaryOnly || failedListeningOnly) {
    try {
      if (chapterBoundaryOnly) await assertScrollChapterBoundary(browser);
      if (failedListeningOnly) await assertFailedListeningStart(browser);
    } finally {
      await browser.close();
    }
    return;
  }
  const context = await browser.newContext({
    ...(browserEngine === 'webkit' && tabletViewport ? devices['iPad Pro 11'] : {}),
    viewport: mobileViewport
      ? mobileSize
      : tabletViewport
        ? { width: 834, height: 1194 }
        : { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    reducedMotion,
  });
  await emulateSafariWithoutIdleCallback(context);
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      !text.includes('Failed to load resource: the server responded with a status of 404')
    ) {
      browserErrors.push(text);
    }
  });

  try {
    if (hasArg('--epub-footnote-only')) {
      const { epubFixture } = await import('./desktop/embedded-format-fixtures.mjs');
      await openImportedNovelReader(page, {
        name: 'reader-footnote.epub',
        mimeType: 'application/epub+zip',
        buffer: await epubFixture(),
      });
      const reader = page.locator('.reader-screen.immersive');
      const link = reader.getByRole('link', { name: 'Footnote 1' });
      const viewport = page.locator('.reader-viewport-layer.is-active');
      const originalScroll = await viewport.evaluate((element) => element.scrollTop);
      await link.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: '각주', exact: true });
      await dialog.getByText('The footnote is readable.', { exact: true }).waitFor({ state: 'visible' });
      const close = dialog.getByRole('button', { name: '각주 닫기', exact: true });
      await dialog.evaluate(async (panel) => {
        await Promise.allSettled(
          [...panel.getAnimations(), ...(panel.parentElement?.getAnimations() ?? [])].map(
            (animation) => animation.finished,
          ),
        );
      });
      await assertPointerReachable(close, 'Footnote close button');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '각주 닫기');
      await page.keyboard.press('Shift+Tab');
      if (
        !(await dialog
          .getByRole('button', { name: '닫기', exact: true })
          .evaluate((button) => button === document.activeElement))
      ) {
        throw new Error('Tab moved out of the footnote dialog');
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      if (!(await link.evaluate((element) => element === document.activeElement))) {
        throw new Error('Closing a footnote did not return focus to its reference');
      }
      if ((await viewport.evaluate((element) => element.scrollTop)) !== originalScroll) {
        throw new Error('Closing a footnote moved the reading position');
      }
      await page.keyboard.press('/');
      const searchLabel = mobileViewport || tabletViewport ? '모바일 본문 검색' : '본문 검색';
      await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, searchLabel);
      const search = page.getByRole('textbox', { name: searchLabel, exact: true });
      await page.keyboard.type('mo');
      const query = await search.inputValue();
      if (query !== 'mo')
        throw new Error(`Search shortcut expected "mo" in the field and found ${JSON.stringify(query)}`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('m');
      await reader.waitFor();
      await page.keyboard.press('m');
      await page.locator('.reader-screen.chrome-visible').waitFor();
      log(
        'EPUB footnote keeps its close button reachable and restores focus and position; keyboard opens search and controls.',
      );
      return;
    }
    await openReader(page);
    await assertReaderDomIsBounded(page);
    if (selectionControlsOnly) {
      await verifyReaderControls(page, {
        font: !mobileViewport,
        captureSelection: () => screenshot(page, 'reader-ui-smoke-selection-controls'),
      });
      if (browserErrors.length) throw new Error(browserErrors.join('\n'));
      log('Selection save/delete, immersive latch, automatic reading entry and toolbar layout passed');
      return;
    }
    if (initialContentOnly) {
      await assertChromeOverlayKeepsReaderFrame(page);
      await assertPaginatedChromeOverlayKeepsReaderFrame(page);
      log(
        `Initial content rendered without input and overlay controls kept scroll/page frames fixed (${mobileViewport ? 'mobile' : tabletViewport ? 'tablet' : 'desktop'})`,
      );
      return;
    }
    await revealReaderChrome(page);
    await assertVisible(page, '.reader-topbar', 'desktop reader topbar');
    await assertNoHorizontalOverflow(page, 'desktop reader');
    await screenshot(page, 'reader-ui-smoke-desktop');

    if (!tabletViewport && !mobileViewport) {
      const search = page.getByRole('textbox', { name: '본문 검색', exact: true });
      const results = page.locator('.search-result-strip');
      await search.fill('빗소리');
      await results
        .getByRole('status')
        .filter({ hasText: novelFile ? /개 결과|^결과 없음$/u : /^1개 결과$/u })
        .waitFor({ state: 'visible', timeout: timeoutMs });
      await assertNoHorizontalOverflow(page, 'desktop reader search');
      await results.getByRole('button', { name: '본문 검색 닫기', exact: true }).click();
      await results.waitFor({ state: 'hidden' });
    }
    const tools = await openReaderTools(page);
    const playback = await openListeningTab(tools);
    const paragraphLabel = await playback.locator('.un-listen-now b').innerText();
    const paragraphCount = Number(paragraphLabel.match(/(?:^|\/\s*)(\d+)(?:개 문단)?$/u)?.[1]);
    if (!Number.isInteger(paragraphCount) || paragraphCount < 1) {
      throw new Error(`Listening panel did not show the chapter size: ${JSON.stringify(paragraphLabel)}`);
    }
    await tools.getByRole('button', { name: '읽기 도구 닫기', exact: true }).click();
    await tools.waitFor({ state: 'hidden' });
    const chapterTitle = page.locator('.un-reader-title strong');
    const chapterBeforePageIntent = await chapterTitle.innerText();
    const lastFullyVisibleBlock = await page.evaluate(() => {
      const root = document.querySelector('[data-reader-layer="scroll"].is-active');
      if (!(root instanceof HTMLElement)) return -1;
      const style = getComputedStyle(root);
      const rootRect = root.getBoundingClientRect();
      const top = rootRect.top + (Number.parseFloat(style.paddingTop) || 0);
      const bottom = rootRect.bottom - (Number.parseFloat(style.paddingBottom) || 0);
      return [...root.querySelectorAll('[data-index]')].reduce((last, row) => {
        const paragraph = row.querySelector('[data-paragraph-id]');
        const rect = paragraph?.getBoundingClientRect();
        const readable = paragraph?.textContent?.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '');
        return rect && readable && rect.top >= top - 1 && rect.bottom <= bottom + 1
          ? Math.max(last, Number(row.getAttribute('data-index') ?? -1))
          : last;
      }, -1);
    });
    log('Checking automatic scroll-to-page transition');
    await page.locator('[data-reader-layer="scroll"].is-active').press('PageDown');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(500);
    const automaticLayout = await assertPaginatedPageFitsViewport(page, 'automatic paginated reader');
    await screenshot(page, 'reader-ui-smoke-scroll-to-page');
    const chapterAfterPageIntent = await chapterTitle.innerText();
    const transitionStart = await page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
      index: Number(element.getAttribute('data-page-start-index') ?? -1),
      offset: Number(element.getAttribute('data-page-start-offset') ?? 0),
    }));
    const transitionAnchor = {
      index: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor')),
      offset: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-offset')),
    };
    if (paragraphCount > 20 && transitionStart.index < paragraphCount - 1 && automaticLayout.contentFillRatio < 0.55) {
      throw new Error(`Scroll-to-page left most of the reading frame empty: ${JSON.stringify(automaticLayout)}`);
    }
    if (
      chapterAfterPageIntent === chapterBeforePageIntent &&
      (transitionStart.index !== transitionAnchor.index || transitionStart.offset !== transitionAnchor.offset)
    ) {
      throw new Error(
        `Scroll-to-page did not begin at its exact continuation anchor: ${JSON.stringify({ transitionStart, transitionAnchor })}`,
      );
    }

    if (novelFile && importedChapterCount > 1) {
      log('Checking real-novel previous/next chapter boundary');
      await page.keyboard.press('Home');
      await page.waitForFunction(
        () =>
          document.querySelector('.reader-paginated-page.is-current')?.getAttribute('data-page-start-index') === '0',
        undefined,
        { timeout: timeoutMs },
      );
      const chapterBeforeBoundary = await chapterTitle.innerText();
      await page.keyboard.press('PageUp');
      await page.waitForFunction(
        (previousTitle) => document.querySelector('.un-reader-title strong')?.textContent?.trim() !== previousTitle,
        chapterBeforeBoundary.trim(),
        { timeout: timeoutMs },
      );
      await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
      await page.locator('.reader-paginated-page.is-current .reader-paragraph').first().waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
      await assertChapterHeading(page, 'next chapter first page');
      await page.keyboard.press('End');
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        (expectedTitle) => document.querySelector('.un-reader-title strong')?.textContent?.trim() === expectedTitle,
        chapterBeforeBoundary.trim(),
        { timeout: timeoutMs },
      );
      await page.locator('.reader-paginated-page.is-current .reader-paragraph').first().waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
    }
    if (
      chapterAfterPageIntent === chapterBeforePageIntent &&
      lastFullyVisibleBlock < paragraphCount - 1 &&
      (transitionStart.index < lastFullyVisibleBlock ||
        (transitionStart.index === lastFullyVisibleBlock && transitionStart.offset === 0))
    ) {
      throw new Error(
        `Scroll-to-page repeated already-read blocks: ${JSON.stringify({
          lastFullyVisibleBlock,
          transitionStart,
          transitionAnchor,
          chapterBeforePageIntent,
          chapterAfterPageIntent,
          paragraphCount,
        })}`,
      );
    }

    const settings = await openReaderLookFromQuickView(page);
    await assertNoHorizontalOverflow(page, 'desktop settings panel');
    const saveTheme = settings.getByRole('button', { name: '지금 색 저장', exact: true });
    await saveTheme.click();
    const themePrompt = page.getByRole('dialog', { name: '지금 색을 테마로 저장' });
    await themePrompt.waitFor();
    await page.keyboard.press('Escape');
    await themePrompt.waitFor({ state: 'hidden' });
    if (
      !(await saveTheme.evaluate(
        (button) => button === document.activeElement && document.documentElement.style.overflow === 'hidden',
      ))
    )
      throw new Error('Closing a nested sheet must restore focus and keep settings scroll locked');
    const modeLock = settings.getByRole('radiogroup', { name: '읽기 방식', exact: true });
    await modeLock.getByRole('radio', { name: '자동', exact: true, checked: true }).waitFor();
    await modeLock.getByRole('radio', { name: '스크롤', exact: true }).waitFor();
    await modeLock.getByRole('radio', { name: '페이지', exact: true }).waitFor();
    await settings
      .getByRole('radiogroup', { name: '넘김 효과', exact: true })
      .getByRole('radio', { name: '부드럽게', exact: true })
      .click();
    await screenshot(page, 'reader-ui-smoke-settings');
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
    log('Checking automatic page navigation and wheel-to-scroll transition');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('.reader-paginated-page.is-current').waitFor({ state: 'visible', timeout: timeoutMs });
    if (paragraphCount > 20) {
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(220);
      await assertVisible(page, '.reader-paginated-page.is-current .reader-paragraph', 'paginated reader page');
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(220);
      await page.keyboard.press('PageDown');
    }
    const automaticPageStartIndex = Number(
      await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor'),
    );
    const automaticPageStartId =
      (await page.locator('.reader-paginated-page.is-current').getAttribute('data-page-start-id')) ?? '';
    const pageContentFrame = { top: automaticLayout.stageTop, bottom: automaticLayout.stageBottom };
    await screenshot(page, 'reader-ui-smoke-before-page-to-scroll-reverse');
    const nativeScrollReady = await page.evaluate(() => {
      const samples = [];
      window.__readerFlowSwapSamples = samples;
      const capture = () => {
        const screen = document.querySelector('.reader-screen');
        const paginated = document.querySelector('.reader-paginated-root');
        const scroll = document.querySelector('[data-reader-layer="scroll"]');
        const scrollDocument = scroll?.querySelector(':scope > .reader-document');
        samples.push({
          frame: samples.length,
          at: performance.now(),
          settling: screen?.getAttribute('data-flow-transition-settling') === 'true',
          pageVisibility: paginated ? getComputedStyle(paginated).visibility : 'missing',
          scrollVisibility: scrollDocument ? getComputedStyle(scrollDocument).visibility : 'missing',
          scrollTop: scroll instanceof HTMLElement ? scroll.scrollTop : Number.NaN,
        });
        if (samples.length < 90) requestAnimationFrame(capture);
      };
      capture();
      return Boolean(document.querySelector('.reader-paginated-root.is-active.native-scroll-ready'));
    });
    await wheelOverPage(page, -240);
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(220);
    const flowSwapSamples = await page.evaluate(() => window.__readerFlowSwapSamples ?? []);
    const settlingSamples = flowSwapSamples.filter((sample) => sample.settling);
    const firstSettlingSample = settlingSamples[0];
    const firstRevealedSample = flowSwapSamples.find(
      (sample) => !sample.settling && sample.scrollVisibility === 'visible',
    );
    const settlingDurationMs =
      firstSettlingSample && firstRevealedSample ? firstRevealedSample.at - firstSettlingSample.at : 0;
    log(`Page-to-scroll handoff settled in ${Math.round(settlingDurationMs)}ms / ${settlingSamples.length} frames`);
    const reverseSamples = flowSwapSamples
      .filter((sample) => !sample.settling && sample.scrollVisibility === 'visible')
      .map((sample) => sample.scrollTop);
    if (
      flowSwapSamples[0]?.pageVisibility !== 'visible' ||
      flowSwapSamples[0]?.scrollVisibility !== 'hidden' ||
      !firstRevealedSample ||
      (!nativeScrollReady && settlingSamples.length === 0) ||
      settlingSamples.length > 8 ||
      settlingDurationMs > 180 ||
      flowSwapSamples.some((sample) =>
        firstRevealedSample && sample.frame >= firstRevealedSample.frame
          ? sample.settling || sample.pageVisibility !== 'hidden' || sample.scrollVisibility !== 'visible'
          : sample.pageVisibility !== 'visible' || sample.scrollVisibility !== 'hidden',
      )
    ) {
      throw new Error(
        `Page-to-scroll exposed or retained an unsettled layer: ${JSON.stringify({ nativeScrollReady, settlingDurationMs, flowSwapSamples })}`,
      );
    }
    const reader = page.locator('.reader-screen');
    if ((await reader.getAttribute('data-reading-flow')) !== 'scroll') {
      throw new Error('Wheel input did not return automatic mode to continuous scroll');
    }
    const automaticScrollRestore = await page.evaluate(() => {
      const root = document.querySelector('[data-reader-layer="scroll"].is-active');
      if (!(root instanceof HTMLElement)) return { scrollTop: 0, firstIndex: -1 };
      const contentTop = root.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(root).paddingTop) || 0);
      const first = [...root.querySelectorAll('[data-index]')].find(
        (element) => element.getBoundingClientRect().bottom > contentTop + 1,
      );
      return {
        scrollTop: root.scrollTop,
        scrollbarWidth: root.offsetWidth - root.clientWidth,
        firstIndex: Number(first?.getAttribute('data-index') ?? -1),
        canScroll: root.scrollHeight > root.clientHeight + 1,
        contentTop,
        nearby: [...root.querySelectorAll('[data-index]')]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              index: Number(element.getAttribute('data-index')),
              id: element.querySelector('[data-paragraph-id]')?.getAttribute('data-paragraph-id'),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              text: element.textContent?.trim().slice(0, 24),
            };
          })
          .filter((item) => item.bottom > contentTop - 200 && item.top < contentTop + 500)
          .slice(0, 12),
      };
    });
    const scrollContentFrame = await page.locator('[data-reader-layer="scroll"].is-active').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: rect.top + (Number.parseFloat(style.paddingTop) || 0),
        bottom: rect.bottom - (Number.parseFloat(style.paddingBottom) || 0),
      };
    });
    await screenshot(page, 'reader-ui-smoke-page-to-scroll-reverse');
    const reverseStart = nativeScrollReady ? flowSwapSamples[0].scrollTop : reverseSamples[0];
    const reverseMotion = reverseStart - automaticScrollRestore.scrollTop;
    const reversedDirection = reverseSamples.some((value, index) => index > 0 && value > reverseSamples[index - 1] + 2);
    if (
      (paragraphCount > 20 &&
        automaticPageStartIndex > 0 &&
        automaticScrollRestore.canScroll &&
        automaticScrollRestore.scrollTop <= 0) ||
      reverseSamples.some((value) => !Number.isFinite(value)) ||
      (paragraphCount > 20 && (reverseMotion < 20 || reversedDirection)) ||
      automaticScrollRestore.scrollbarWidth !== 0 ||
      (pageContentFrame &&
        (Math.abs(pageContentFrame.top - scrollContentFrame.top) > 2 ||
          Math.abs(pageContentFrame.bottom - scrollContentFrame.bottom) > 2)) ||
      (paragraphCount > 20 &&
        automaticPageStartId.length > 0 &&
        !automaticScrollRestore.nearby.some((item) => item.id === automaticPageStartId))
    ) {
      throw new Error(
        `Immediate reverse wheel transition stalled or jittered: ${JSON.stringify({ automaticPageStartIndex, automaticPageStartId, automaticScrollRestore, reverseSamples, pageContentFrame, scrollContentFrame })}`,
      );
    }

    log('Checking scroll-to-previous-page round trip');
    await page.keyboard.press('PageUp');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(220);
    const reverseTransitionAnchor = {
      index: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor')),
      offset: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-offset')),
    };
    await page.waitForTimeout(1_000);
    const previousPageBoundary = await page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
      startIndex: Number(element.getAttribute('data-page-start-index') ?? -1),
      startOffset: Number(element.getAttribute('data-page-start-offset') ?? 0),
      endIndex: Number(element.getAttribute('data-page-end-index') ?? -1),
      endOffset: Number(element.getAttribute('data-page-end-offset') ?? 0),
    }));
    const hasPreviousScrollContent = reverseTransitionAnchor.index > 0 || reverseTransitionAnchor.offset > 0;
    if (
      hasPreviousScrollContent &&
      (previousPageBoundary.endIndex !== reverseTransitionAnchor.index ||
        previousPageBoundary.endOffset !== reverseTransitionAnchor.offset)
    ) {
      throw new Error(
        `Previous page did not end at the scroll anchor: ${JSON.stringify({ reverseTransitionAnchor, previousPageBoundary })}`,
      );
    }
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(220);
    const returnedPageStart = await currentPageStart(page);
    if (
      hasPreviousScrollContent &&
      (returnedPageStart.index !== reverseTransitionAnchor.index ||
        returnedPageStart.offset !== reverseTransitionAnchor.offset)
    ) {
      throw new Error(
        `Previous/next page round trip lost the scroll anchor: ${JSON.stringify({ reverseTransitionAnchor, returnedPageStart })}`,
      );
    }
    await wheelOverPage(page, 90);
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    if (flowTransitionOnly) {
      log(`Focused flow transition passed (${tabletViewport ? 'tablet' : mobileViewport ? 'mobile' : 'desktop'})`);
      return;
    }

    await setReadingMode(page, '스크롤');
    log('Checking scroll mode lock');
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
    if (await page.locator('.reader-paginated-root.is-active').count()) {
      throw new Error('Scroll lock allowed PageDown to switch into pagination');
    }

    await setReadingMode(page, '페이지');
    log('Checking page mode lock');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await wheelOverPage(page, 220);
    await page.waitForTimeout(300);
    if (!(await page.locator('.reader-paginated-root.is-active').count())) {
      throw new Error('Page lock allowed wheel input to switch into continuous scroll');
    }

    await setReadingMode(page, '자동');
    log('Checking automatic vertical swipe transition');
    await wheelOverPage(page, 220);
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(350);

    log(
      `Automatic mode before PageDown: ${await reader.getAttribute('data-reading-flow')} (lock=${await reader.getAttribute('data-reading-mode-lock')})`,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.keyboard.press('PageDown');
    log(
      `Automatic mode after PageDown: ${await reader.getAttribute('data-reading-flow')} (paginated=${await page.locator('.reader-paginated-root.is-active').count()})`,
    );
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile automatic paginated reader');
    await page.locator('.reader-screen.scroll-to-page-settling').waitFor({ state: 'detached', timeout: timeoutMs });
    await revealReaderChrome(page);
    const mobileAnchorBeforeImmersive = await currentPageStart(page);
    log('Checking mobile immersive layout transition');
    const readerBounds = await page.locator('.reader-paginated-root.is-active').boundingBox();
    await page.mouse.click(readerBounds.x + readerBounds.width / 2, readerBounds.y + readerBounds.height / 2);
    await page.locator('.reader-screen.immersive').waitFor({ state: 'visible', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile immersive paginated reader');
    const mobileAnchorInImmersive = await currentPageStart(page);
    if (
      mobileAnchorInImmersive.index !== mobileAnchorBeforeImmersive.index ||
      mobileAnchorInImmersive.offset !== mobileAnchorBeforeImmersive.offset
    ) {
      throw new Error(
        `Immersive layout transition lost the reading anchor: ${JSON.stringify({ mobileAnchorBeforeImmersive, mobileAnchorInImmersive })}`,
      );
    }
    await page.keyboard.press('Home');
    await page.waitForFunction(
      () => {
        const current = document.querySelector('.reader-paginated-page.is-current');
        return (
          current?.getAttribute('data-page-start-index') === '0' &&
          current?.getAttribute('data-page-start-offset') === '0'
        );
      },
      undefined,
      { timeout: timeoutMs },
    );
    await assertChapterHeading(page, 'immersive chapter first page');
    await assertPaginatedPageFitsViewport(page, 'immersive chapter heading page');
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 195,
      clientY: 422,
    });
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 195,
      clientY: 422,
    });
    await page.locator('.reader-screen.immersive').waitFor({ state: 'detached', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile standard paginated reader after immersive');
    const mobilePage = page.locator('.reader-paginated-root.is-active');
    if (browserEngine === 'chromium') {
      const touch = await context.newCDPSession(page);
      await dispatchTouch(mobilePage, touch, 'touchstart', 620);
      for (const y of [580, 530, 485, 450]) await dispatchTouch(mobilePage, touch, 'touchmove', y);
      await dispatchTouch(mobilePage, touch, 'touchend');
      await touch.detach();
    } else {
      await mobilePage.dispatchEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 195,
        clientY: 620,
      });
      await mobilePage.dispatchEvent('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 194,
        clientY: 450,
      });
    }
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(700);
    const mobileScroll = await page.locator('[data-reader-layer="scroll"].is-active').evaluate((element) => ({
      scrollTop: element.scrollTop,
      canScroll: element.scrollHeight > element.clientHeight + 1,
    }));
    if (mobileScroll.canScroll && mobileScroll.scrollTop <= 0) {
      throw new Error(
        `Mobile vertical swipe switched flow but did not apply its scroll delta: ${JSON.stringify(mobileScroll)}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(300);

    const addon = await openReaderTools(page);
    await openListeningTab(addon);
    const aiTab = addon.getByRole('tab', { name: 'AI', exact: true });
    if (await aiTab.isVisible()) {
      await aiTab.click();
    } else {
      await addon.getByRole('button', { name: /^세부 청취 설정/u }).click();
      await addon.getByRole('button', { name: 'AI 도구', exact: true }).click();
    }
    await addon.getByRole('tab', { name: 'AI', exact: true, selected: true }).waitFor();
    await addon.getByRole('heading', { name: 'AI 분석', exact: true }).waitFor();
    await addon
      .getByText('AI 분석 기능을 꺼도 일반 듣기와 시스템 음성은 계속 사용할 수 있습니다.', {
        exact: true,
      })
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await addon.getByText('화 단위 작업 및 연결 설정', { exact: true }).click();
    await addon.getByRole('button', { name: '묶음 인물 분석', exact: true }).waitFor();
    await assertNoHorizontalOverflow(page, 'desktop addon panel');
    await screenshot(page, 'reader-ui-smoke-addon');

    // A viewport failure should still fail the run after the remaining layouts and independent cases execute.
    const failures = [];
    for (const { label, width, height } of [
      { label: 'tablet', width: 820, height: 1180 },
      { label: 'mobile', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      await assertVisible(page, '.reader-topbar', `${label} reader topbar`);
      await assertReaderDomIsBounded(page);
      await assertNoHorizontalOverflow(page, `${label} reader with addon`, failures);
      await screenshot(page, `reader-ui-smoke-${label}-addon`);
    }

    await addon.getByRole('button', { name: '읽기 도구 닫기', exact: true }).click();
    await addon.waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page, 'mobile reader', failures);
    await screenshot(page, 'reader-ui-smoke-mobile');

    if (!novelFile) await assertScrollChapterBoundary(browser);
    await assertFailedListeningStart(browser);

    if (browserErrors.length) {
      failures.push(`Browser console/page errors detected: ${browserErrors.join(' | ')}`);
    }
    if (failures.length) throw new Error(`Default reader UI smoke failed:\n${failures.join('\n')}`);
    log('Default reader UI smoke passed');
  } finally {
    await context.close();
    await browser.close();
  }
}

withServer(runReaderSmoke).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
