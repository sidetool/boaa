import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { chromium } from 'playwright-core';
import { findTemporaryLoopbackPort } from '../lib/temporary-loopback-port.mjs';

// Each format starts in a fresh app/profile so another import cannot prime its lazy chunks.
const { values } = parseArgs({ options: { dist: { type: 'string', default: 'dist' } } });
const dist = resolve(values.dist);
const base = await readFile(resolve(dist, 'offline-manifest.json'), 'utf8')
  .then((text) => JSON.parse(text).base)
  .catch((error) => {
    if (error.code === 'ENOENT') return '/';
    throw error;
  });
assert.ok(typeof base === 'string' && base.startsWith('/') && base.endsWith('/'));
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
const marker = 'Synthetic first use content remains readable.';
async function epub() {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
  await zip.add(
    'META-INF/container.xml',
    new TextReader(
      '<container><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  await zip.add(
    'book.opf',
    new TextReader(`<package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic-first-use</dc:identifier><dc:title>Synthetic EPUB</dc:title><dc:language>en</dc:language></metadata>
      <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="chapter"/></spine></package>`),
  );
  await zip.add(
    'chapter.xhtml',
    new TextReader(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title></head><body><h1>First chapter</h1><p>${marker}</p></body></html>`,
    ),
  );
  return Buffer.from(await zip.close());
}

const browser = await chromium.launch({ channel: process.env.READER_UI_BROWSER_CHANNEL || 'chromium', headless: true });
const evidence = [];
try {
  for (const format of ['txt', 'epub', 'cbz']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || !url.pathname.startsWith(base)) return route.abort();
      const pathname = url.pathname.slice(base.length);
      if (pathname === 'runtime-config.js')
        return route.fulfill({
          contentType: 'application/javascript',
          body: 'globalThis.__BOAA_RUNTIME_CONFIG__ = Object.freeze({schemaVersion: 1});',
        });
      const file = resolve(dist, decodeURIComponent(pathname || 'index.html'));
      if (!file.startsWith(dist + sep)) return route.abort();
      try {
        return await route.fulfill({
          body: await readFile(file),
          contentType: types[extname(file)] || 'application/octet-stream',
        });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(origin + base);
      let buffer;
      if (format === 'cbz') {
        const png = await page.evaluate(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = 300;
          canvas.getContext('2d').fillRect(0, 0, 200, 300);
          return canvas.toDataURL().split(',')[1];
        });
        const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
        for (const name of ['001.png', '002.png'])
          await zip.add(name, new Uint8ArrayReader(Buffer.from(png, 'base64')));
        buffer = Buffer.from(await zip.close());
      } else buffer = format === 'epub' ? await epub() : Buffer.from(`First chapter\n\n${marker}\n`);
      await page.getByRole('button', { name: '파일 가져오기', exact: true }).click();
      await page.locator('input[type=file]').setInputFiles({
        name: `Synthetic first use.${format}`,
        mimeType: { txt: 'text/plain', epub: 'application/epub+zip', cbz: 'application/vnd.comicbook+zip' }[format],
        buffer,
      });
      await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
      if (format === 'cbz') {
        await page.getByRole('button', { name: '첫 회차 보기', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.fixed-doc-viewport img')?.naturalWidth > 0);
        await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('input[aria-label="현재 페이지"]')?.value === '2');
      } else {
        await page.getByRole('button', { name: '첫 화 보기', exact: true }).first().click();
        await page.locator('[data-reader-layer]').getByText(marker, { exact: false }).first().waitFor();
      }
      assert.deepEqual(errors, []);
      evidence.push({ format, firstImportReadable: true, browserErrors: errors });
    } catch (error) {
      console.error(
        JSON.stringify({ format, errors, body: (await page.locator('body').innerText()).slice(0, 3000) }, null, 2),
      );
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
