import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-chapter-boundary-fixture.mjs' } },
});
const assets = new Map(bundle.output.map((asset) => [`/${asset.fileName}`, asset]));
const entry = bundle.output.find((asset) => asset.isEntry);
const styles = bundle.output.filter((asset) => asset.fileName.endsWith('.css'));
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`).join('')}<script type="module" src="/${entry.fileName}"></script>`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.READER_UI_BROWSER_EXECUTABLE
    ? { executablePath: process.env.READER_UI_BROWSER_EXECUTABLE }
    : { channel: process.env.READER_UI_BROWSER_CHANNEL || 'chromium' }),
});
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const asset = assets.get(pathname);
      return route.fulfill({
        status: pathname === '/reader' || asset ? 200 : 404,
        contentType: pathname === '/reader' ? 'text/html' : asset?.type === 'chunk' ? 'text/javascript' : 'text/css',
        body: pathname === '/reader' ? html : (asset?.code ?? asset?.source ?? ''),
      });
    });
    for (const [font, line] of [
      [18, 1.85],
      [40, 3],
    ]) {
      await page.goto(`http://reader.invalid/reader?font=${font}&line=${line}`);
      await page.waitForSelector('.reader-chapter-separator');
      const result = await page.evaluate(() =>
        [...document.querySelectorAll('.reader-chapter-separator, .reader-chapter-lead')].map((root) => {
          const bounds = root.getBoundingClientRect();
          const style = getComputedStyle(root);
          // A long title may ellipsize horizontally, but no line may be cut vertically.
          const clipped = [...root.children].some((child) => {
            if (!child.textContent) return false;
            const range = document.createRange();
            range.selectNodeContents(child);
            const rect = range.getBoundingClientRect();
            return rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5;
          });
          return {
            kind: root.classList.contains('reader-chapter-lead') ? 'lead' : 'separator',
            height: bounds.height,
            clipped,
            fontStyle: style.fontStyle,
            letterSpacing: style.letterSpacing,
            outside: bounds.left < 0 || bounds.right > innerWidth,
          };
        }),
      );
      assert.equal(result.length, 8);
      for (const row of result) {
        assert.equal(row.height, row.kind === 'lead' ? 40 : 112);
        assert.equal(row.clipped, false, JSON.stringify({ width, font, line, row }));
        assert.equal(row.outside, false);
        assert.equal(row.fontStyle, 'normal');
        assert.equal(row.letterSpacing, 'normal');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px, body ${font}px/${line}: all 8 boundary states fit`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
