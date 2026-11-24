import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: { write: false, rollupOptions: { input: 'scripts/performance/reader-sheet-fixture.mjs' } },
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
  for (const [width, reducedMotion] of [
    [390, 'no-preference'],
    [1280, 'no-preference'],
    [390, 'reduce'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion });
    page.setDefaultTimeout(5000);
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
    await page.goto('http://reader.invalid/reader');
    for (const kind of ['reader', 'settings', 'files']) {
      await page.locator(`#open-${kind}`).click();
      await page.waitForSelector('[role="dialog"]', { state: 'attached' });
      const evidence = await page.evaluate(() => {
        const animations = document.getAnimations();
        const samples = [];
        for (const time of [0, 100, 299]) {
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = time;
          }
          samples.push(window.sheetSnapshot());
        }
        for (const animation of animations) animation.finish();
        return { first: window.sheetProbe.first, samples, finished: window.sheetSnapshot() };
      });
      const modal = kind !== 'reader' || width < 700;
      assert.equal(evidence.first.fixed, modal, 'The first commit already has the correct layout');
      assert.equal(evidence.first.modal, modal ? 'true' : null);
      for (const sample of [evidence.first, ...evidence.samples, evidence.finished]) {
        assert.equal(sample.opacity, '1', 'No ancestor fade may make the panel translucent');
        // Translated DOMRects can differ by floating-point rounding, well below a CSS pixel.
        assert.ok(Math.abs(sample.height - evidence.first.height) < 0.01, 'Opening must not change panel size');
        assert.ok(Math.abs(sample.width - evidence.first.width) < 0.01);
      }
      if (width < 700) assert.notEqual(evidence.finished.transform, 'none', 'Retain the mobile slide transform');
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
      if (kind === 'reader') {
        await page.getByRole('tab', { name: '주석' }).click();
        assert.equal(await page.locator('.un-tools-head h2').textContent(), '주석');
        assert.equal(
          await page.evaluate(() =>
            ['.un-tools-layer', '.un-tools'].reduce(
              (count, selector) => count + document.querySelector(selector).getAnimations().length,
              0,
            ),
          ),
          0,
          'Tab changes must not replay entry',
        );
        if (modal) {
          await page.locator('#last-control').focus();
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-reader-addon-close')), true);
        }
      }
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]', { state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.id), `open-${kind}`);
      assert.equal(await page.evaluate(() => document.querySelectorAll('[inert]').length), 0);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px/${reducedMotion}: first layout, opaque entry, stable size, tabs, focus and close`);
    await page.close();
  }
} finally {
  await browser.close();
}
