import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';

// Capture/restore must agree at wrapped spaces as well as visible glyphs.
// Uses the real viewport and CSS; every request is fulfilled from a synthetic bundle.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-position-fixture.mjs' } },
});
const assets = new Map(bundle.output.map((asset) => [`/${asset.fileName}`, asset]));
const entry = bundle.output.find((asset) => asset.isEntry);
const styles = bundle.output.filter((asset) => asset.fileName.endsWith('.css'));
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`).join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.READER_UI_BROWSER_EXECUTABLE
    ? { executablePath: process.env.READER_UI_BROWSER_EXECUTABLE }
    : { channel: process.env.READER_UI_BROWSER_CHANNEL || 'chromium' }),
});
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const asset = assets.get(path);
      return route.fulfill({
        status: path === '/reader' || asset ? 200 : 404,
        contentType: path === '/reader' ? 'text/html' : asset?.type === 'chunk' ? 'text/javascript' : 'text/css',
        body: path === '/reader' ? html : (asset?.code ?? asset?.source ?? ''),
      });
    });
    await page.goto('http://reader.invalid/reader?single');
    await page.waitForFunction(() => readerFixture?.api()?.getAnchor());
    await page.waitForTimeout(250);
    const result = await page.evaluate(async () => {
      const root = document.querySelector('[data-reader-layer="scroll"]');
      const frames = async () => {
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
      };
      const results = [];
      for (const top of [200, 350, 500, 650, 800]) {
        root.scrollTop = top;
        await frames();
        const before = readerFixture.api().getAnchor();
        const restored = await readerFixture.api().scrollToAnchor(before);
        await frames();
        const after = readerFixture.api().getAnchor();
        results.push({
          top,
          restored,
          before: before.offset,
          after: after.offset,
          sameBlock: before.blockId === after.blockId,
        });
      }
      return results;
    });
    console.log(JSON.stringify({ width, result, errors }));
    assert.deepEqual(errors, []);
    for (const turn of result) {
      assert.equal(turn.restored, true);
      assert.equal(turn.sameBlock, true);
      assert.equal(turn.after, turn.before, `width ${width}, scrollTop ${turn.top}: anchor changed on restore`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
