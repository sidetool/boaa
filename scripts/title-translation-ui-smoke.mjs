// Real cards/settings/client + Chromium. Synthetic HTTP only; never calls a paid provider.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findTemporaryLoopbackPort } from './lib/temporary-loopback-port.mjs';
const port = await findTemporaryLoopbackPort();
const base = `http://127.0.0.1:${port}`;
const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: 'ignore',
});
const directory = path.join(os.tmpdir(), 'boaa-title-translation-smoke');
await fs.mkdir(directory, { recursive: true });
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let config = {
      settings: {
        enabled: true,
        automatic: false,
        translateTitles: false,
        provider: 'gemini',
        model: 'synthetic',
        targetLanguage: 'ko',
        endpoint: 'https://api.openai.com/v1',
        project: '',
        location: 'global',
        chunkCharacters: 6000,
        concurrency: 1,
        nextChapters: 1,
        retries: 0,
        backoffSeconds: 2,
        timeoutSeconds: 120,
        instructions: '',
        glossary: '',
      },
      revision: 1,
      credentials: { gemini: { saved: true } },
      usedCharacters: 0,
    };
    const translated = { 'A Journey Beyond the Stars': '별 너머로 떠나는 여행', 'The Quiet Library': '고요한 도서관' };
    const batches = [];
    await page.route('**/api/translation/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()).pathname;
      let result;
      if (url.endsWith('/settings')) {
        if (request.method() === 'PUT')
          config = { ...config, settings: request.postDataJSON().settings, revision: config.revision + 1 };
        result = config;
      } else if (url.endsWith('/titles')) {
        const titles = request.postDataJSON().titles;
        batches.push(titles);
        result = {
          titles: titles.map((original) => ({ original, translated: translated[original], status: 'complete' })),
        };
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else throw new Error(`Unexpected route ${url}`);
      await route.fulfill({ json: result });
    });
    await page.goto(`${base}/src/test/smoke/title-translation.html`);
    await page.getByRole('button', { name: 'A Journey Beyond the Stars 상세 보기', exact: true }).waitFor();
    await page.waitForTimeout(600);
    assert(batches.length === 0, 'Disabled title translation made requests');
    await page.getByRole('button', { name: '번역 설정', exact: true }).click();
    await page.getByRole('switch', { name: '작품 제목도 번역', exact: true }).click();
    await page.getByRole('button', { name: '번역 설정 저장', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('저장했어요'));
    assert(config.settings.automatic === false, 'Title option changed chapter automation');
    assert(!('dailyCharacters' in config.settings), 'Removed quota was saved');
    await page.screenshot({ path: path.join(directory, `settings-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '목록으로', exact: true }).click();
    await page.getByRole('button', { name: '별 너머로 떠나는 여행 상세 보기', exact: true }).waitFor();
    assert(batches.length === 1 && batches[0].length === 2, 'Visible titles were not batched together');
    assert(
      (await page.locator('.un-tile-title').first().getAttribute('title')) === 'A Journey Beyond the Stars',
      'Original title tooltip lost',
    );
    await page.getByRole('button', { name: '별 너머로 떠나는 여행 상세 보기', exact: true }).click();
    assert(
      (await page.getByLabel('원래 작품 식별').textContent()) === 'A Journey Beyond the Stars',
      'Open action received translated identity',
    );
    await page.waitForTimeout(600);
    assert(batches.length === 1, 'Opening a cached title requested another translation');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
    await page.screenshot({ path: path.join(directory, `titles-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '번역 설정', exact: true }).click();
    await page.getByRole('switch', { name: '작품 제목도 번역', exact: true }).click();
    await page.getByRole('button', { name: '번역 설정 저장', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('저장했어요'));
    await page.getByRole('button', { name: '목록으로', exact: true }).click();
    await page.getByRole('button', { name: 'A Journey Beyond the Stars 상세 보기', exact: true }).waitFor();
    assert(errors.length === 0, errors.join('\n'));
    await page.close();
  }
  console.log(`Title translation smoke passed (390/1440px). Screenshots: ${directory}`);
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
