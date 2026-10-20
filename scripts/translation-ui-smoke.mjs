// Real settings, reader viewport and authenticated client; synthetic HTTP responses only.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findTemporaryLoopbackPort } from './lib/temporary-loopback-port.mjs';
const port = await findTemporaryLoopbackPort();
const base = `http://127.0.0.1:${port}`;
const directory = path.join(os.tmpdir(), 'boaa-translation-smoke');
await fs.mkdir(directory, { recursive: true });
const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: 'ignore',
});
let browser;
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* Vite is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let config = {
      settings: {
        enabled: false,
        automatic: false,
        provider: 'gemini',
        model: '',
        targetLanguage: 'ko',
        endpoint: 'https://api.openai.com/v1',
        project: '',
        location: 'global',
        chunkCharacters: 6000,
        concurrency: 1,
        nextChapters: 1,
        retries: 3,
        backoffSeconds: 2,
        timeoutSeconds: 120,
        translateTitles: false,
        instructions: '',
        glossary: '',
      },
      revision: 0,
      credentials: {},
      usedCharacters: 0,
    };
    let calls = 0,
      polls = 0;
    const translated = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i + 1}`,
      text: `${i + 1} 번역한 테스트 문단입니다. ${'줄 길이가 달라져도 다음 문단과 겹치면 안 됩니다. '.repeat(4 + (i % 10))}`,
    }));
    const job = {
      id: 'job',
      workKey: 'synthetic-book',
      chapterKey: 'synthetic-chapter',
      sourceHash: 'hash',
      status: 'queued',
      targetLanguage: 'ko',
      provider: 'gemini',
      model: 'synthetic-model',
      completed: 0,
      total: 100,
      paragraphs: [],
    };
    await page.route('**/api/translation/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()).pathname,
        method = request.method();
      let result;
      if (url.endsWith('/settings')) {
        if (method === 'PUT') {
          config = { ...config, settings: request.postDataJSON().settings, revision: config.revision + 1 };
        }
        result = config;
      } else if (url.includes('/credentials/')) {
        config.credentials.gemini = { saved: true };
        result = { saved: true };
      } else if (url.endsWith('/jobs') && method === 'POST') {
        if (request.postDataJSON().lookupOnly) result = { result: null };
        else {
          calls++;
          result = { result: job };
        }
      } else if (url.endsWith('/jobs/job')) {
        polls++;
        const done = polls >= 2;
        result = {
          ...job,
          status: done ? 'complete' : 'running',
          completed: done ? 100 : 20,
          paragraphs: translated.slice(0, done ? 100 : 20),
        };
      } else throw new Error(`Unexpected API ${method} ${url}`);
      await route.fulfill({ json: result });
    });
    await page.goto(`${base}/src/test/smoke/translation.html`);
    const translationTab = page
      .getByRole('tablist', { name: '콘텐츠', exact: true })
      .getByRole('tab', { name: /작품 번역/ });
    await translationTab.waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(directory, `settings-navigation-${width}.png`), fullPage: true });
    await translationTab.click();
    await page.getByRole('tabpanel').getByLabel('번역 API 키', { exact: true }).waitFor({ state: 'visible' });
    await page.getByLabel('번역 API 키', { exact: true }).fill('synthetic-secret');
    await page.getByRole('button', { name: '키 저장', exact: true }).click();
    await page.getByText('서버에 암호화해 저장됨 · 원문 조회 불가').waitFor();
    await page.getByLabel('모델 ID', { exact: true }).fill('synthetic-model');
    await page.getByRole('switch', { name: '작품 번역 사용', exact: true }).click();
    const automatic = page.getByRole('switch', { name: '작품을 열면 자동 번역', exact: true });
    const prefetch = page.getByRole('switch', { name: '다음 화 미리 번역', exact: true });
    assert((await prefetch.count()) === 0, 'prefetch should be nested under automatic translation');
    await automatic.click();
    await page.getByLabel('미리 번역할 다음 화', { exact: true }).fill('2');
    await page.screenshot({ path: path.join(directory, `settings-automatic-${width}.png`), fullPage: true });
    await prefetch.click();
    assert(
      (await page.getByLabel('미리 번역할 다음 화', { exact: true }).count()) === 0,
      'disabled prefetch retains visible count control',
    );
    await automatic.click();
    assert((await prefetch.count()) === 0, 'prefetch remains visible after automatic translation is off');

    await page.getByRole('button', { name: '번역 설정 저장', exact: true }).click();
    await page.getByText('번역 설정을 저장했어요.', { exact: false }).waitFor();
    assert(config.settings.enabled, 'settings were not saved');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'settings overflow');
    await page.screenshot({ path: path.join(directory, `settings-${width}.png`), fullPage: true });
    await page.goto(`${base}/src/test/smoke/translation.html?reader`);
    const openTranslation = async () => {
      await page.getByRole('button', { name: '리더 추가 메뉴', exact: true }).click();
      await page.getByRole('button', { name: '작품 번역', exact: true }).click();
    };
    const originalInset = await page.locator('.reader-scroll').evaluate((el) => getComputedStyle(el).paddingTop);
    await openTranslation();
    await page.screenshot({ path: path.join(directory, `confirm-${width}.png`), fullPage: true });
    assert(calls === 0, 'manual mode called provider before consent');
    assert(
      (await page.getByRole('button', { name: /번역하고 다음/ }).count()) === 0,
      'redundant next chapter button remains',
    );
    await page.getByRole('button', { name: '이번 화만 번역', exact: true }).click();
    await page.getByRole('dialog', { name: '작품 번역', exact: true }).waitFor({ state: 'hidden' });
    await openTranslation();
    await page.getByRole('status').filter({ hasText: '서버에 저장됨' }).waitFor();
    await page
      .getByRole('dialog', { name: '작품 번역', exact: true })
      .getByRole('button', { name: '닫기', exact: true })
      .click();
    assert(
      (await page.locator('.reader-scroll').evaluate((el) => getComputedStyle(el).paddingTop)) === originalInset,
      'translation changes reading inset',
    );
    assert((await page.locator('.un-reader-translation-status').count()) === 0, 'translation overlay covers text');
    assert(calls === 1, `duplicate job submission: ${calls}`);
    // Exercise repeated cold-range jumps and width changes, not only the initial viewport.
    for (const targetWidth of [width, width === 390 ? 820 : 1180, width]) {
      await page.setViewportSize({ width: targetWidth, height: 900 });
      for (const destination of ['이번 화 처음으로', '이번 화 끝으로']) {
        await page.getByRole('button', { name: '리더 추가 메뉴', exact: true }).click();
        await page.getByRole('button', { name: destination, exact: true }).click();
        await page.waitForTimeout(800);
        const layout = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('.reader-virtual-row')]
            .map((row) => ({
              index: Number(row.getAttribute('data-index')),
              top: row.getBoundingClientRect().top,
              bottom: row.getBoundingClientRect().bottom,
            }))
            .sort((a, b) => a.index - b.index);
          const overlaps = rows.slice(1).filter((row, i) => row.top < rows[i].bottom - 1);
          const footer = document.querySelector('.chapter-nav').getBoundingClientRect().top;
          return {
            rows,
            overlaps,
            footer,
            footerOverlap: rows.some((row) => row.index === 99 && row.bottom > footer + 1),
          };
        });
        if (layout.overlaps.length || layout.footerOverlap) {
          await page.screenshot({ path: path.join(directory, `reader-probe-${width}.png`), fullPage: true });
          throw new Error(`Reader layout ${width}/${targetWidth}/${destination}: ${JSON.stringify(layout)}`);
        }
      }
    }
    assert((await page.locator('.reader-translated-text').count()) > 0, 'translated reader text missing');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reader overflow');
    await page.screenshot({ path: path.join(directory, `reader-${width}.png`), fullPage: true });
    await openTranslation();
    await page.getByRole('button', { name: '원문 보기', exact: true }).click();
    assert((await page.locator('.reader-translated-text').count()) === 0, 'original toggle failed');
    assert(errors.length === 0, errors.join('\n'));
    await context.close();
  }
  console.log(
    `PASS: 390px/1440px settings, server-key save, manual consent, partial/complete output, reader layout, original toggle. Screenshots: ${directory}`,
  );
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
