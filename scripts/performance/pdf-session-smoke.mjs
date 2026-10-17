import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from '../lib/temporary-loopback-port.mjs';

// Exercise the built app and real PDF.js worker with synthetic content. Network
// access is restricted to local build assets, and the browser profile is fresh.
const { values } = parseArgs({ options: { dist: { type: 'string', default: 'dist' } } });
const dist = resolve(values.dist);
const base = await readFile(resolve(dist, 'offline-manifest.json'), 'utf8')
  .then((text) => JSON.parse(text).base)
  .catch((error) => {
    if (error.code === 'ENOENT') return '/';
    throw error;
  });
assert.ok(typeof base === 'string' && base.startsWith('/') && base.endsWith('/'), 'Invalid build base path');
const origin = `http://127.0.0.1:${await findTemporaryLoopbackPort()}`;
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 1; page <= 3; page++) {
    const contents = `BT /F1 24 Tf 40 200 Td (Synthetic PDF page ${page}) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}endstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  text += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  text += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

await readFile(resolve(dist, 'index.html'));
const browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'chromium', headless: true });
let page;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const assetRequests = new Set();
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith(base)) return route.abort();
    const pathname = url.pathname.slice(base.length);
    if (pathname === 'runtime-config.js')
      return route.fulfill({
        contentType: 'application/javascript',
        body: 'globalThis.__BOAA_RUNTIME_CONFIG__ = Object.freeze({schemaVersion: 1});',
      });
    const file = resolve(dist, decodeURIComponent(pathname || 'index.html'));
    if (!file.startsWith(dist + sep)) return route.abort();
    assetRequests.add(url.pathname);
    try {
      return await route.fulfill({
        body: await readFile(file),
        contentType: types[extname(file)] || 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + base);
  await page.getByRole('button', { name: '파일 가져오기', exact: true }).click();
  assert.equal(
    [...assetRequests].some((file) => file.includes('pdf.worker')),
    false,
    'PDF worker must not load before PDF use',
  );
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'Synthetic session.pdf', mimeType: 'application/pdf', buffer: syntheticPdf() });
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  const waitForPage = async (number) => {
    await page.waitForFunction(
      (value) => document.querySelector('input[aria-label="현재 페이지"]')?.value === value,
      String(number),
    );
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.fixed-doc-viewport .fixed-doc-canvas');
      return canvas && canvas.width > 1 && canvas.height > 1;
    });
    // This scenario verifies persisted resume, not a browser force-close racing
    // the 350ms progress debounce. Observe storage instead of using a fixed sleep.
    const deadline = Date.now() + 15000;
    while (
      !(await page.evaluate(
        (expected) =>
          new Promise((resolve, reject) => {
            const opened = indexedDB.open('boaa-reader');
            opened.onerror = () => reject(opened.error);
            opened.onsuccess = () => {
              const db = opened.result;
              const request = db.transaction('reading_positions', 'readonly').objectStore('reading_positions').getAll();
              request.onerror = () => {
                db.close();
                reject(request.error);
              };
              request.onsuccess = () => {
                db.close();
                resolve(request.result.some((position) => position.scrollTop === expected));
              };
            };
          }),
        number - 1,
      ))
    ) {
      assert.ok(Date.now() < deadline, `Page ${number} was not persisted before the deadline`);
      await page.waitForTimeout(30);
    }
  };
  await waitForPage(1);
  assert.ok(
    [...assetRequests].some((file) => file.includes('pdf.worker')),
    'The real PDF worker must be used',
  );
  // Exercise the actual text repository and tools without an external OCR model/provider.
  await page.getByTitle('PDF 본문 검색', { exact: true }).click();
  const search = page.getByRole('complementary', { name: 'PDF 본문 검색', exact: true });
  const prepareText = search.getByRole('button', { name: '전체 텍스트 준비', exact: true });
  if (await prepareText.isVisible()) await prepareText.click();
  await search.getByText('검색 가능 3 / 3페이지', { exact: true }).waitFor();
  await search.getByRole('textbox', { name: 'PDF 본문 검색어', exact: true }).fill('Synthetic PDF page 2');
  const result = search.locator('.fixed-doc-search-results button');
  await result.first().waitFor();
  assert.equal(await result.count(), 1);
  await result.first().click();
  await waitForPage(2);
  const openOrder = search.getByRole('button', { name: /현재 페이지 읽기 순서/ });
  await openOrder.click();
  const order = search.getByRole('region', { name: '현재 페이지 읽기 순서 교정', exact: true });
  await order.getByRole('button', { name: '검색과 TTS에서 제외', exact: true }).click();
  await order.getByRole('button', { name: '적용', exact: true }).click();
  await order.waitFor({ state: 'hidden' });
  await search.getByText('준비된 페이지에서 결과가 없습니다.', { exact: true }).waitFor();
  await openOrder.click();
  assert.equal(
    await order.getByRole('button', { name: '읽기 순서에 다시 포함', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await order.getByRole('button', { name: '자동 순서로 초기화', exact: true }).click();
  await order.waitFor({ state: 'hidden' });
  await result.first().waitFor();
  await search.getByRole('button', { name: '검색 닫기', exact: true }).click();
  await page.getByRole('button', { name: '이전 페이지', exact: true }).click();
  await waitForPage(1);
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await waitForPage(2);
  await page.locator('.fixed-doc-title-group button').first().click();
  await page.getByRole('button', { name: 'Synthetic session 문서 열기', exact: true }).click();
  await waitForPage(2);
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await waitForPage(3);
  await page.locator('.fixed-doc-title-group button').first().click();
  await page.reload();
  await page.getByRole('button', { name: 'Synthetic session 문서 열기', exact: true }).click();
  await waitForPage(3);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        realPdfWorker: true,
        nativeTextIndexAndSearch: true,
        readingOrderExclusionAndReset: true,
        threePageNavigation: true,
        resumeAfterClose: true,
        resumeAfterReload: true,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({ browserErrors: errors, body: (await page?.locator('body').innerText())?.slice(0, 3000) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
