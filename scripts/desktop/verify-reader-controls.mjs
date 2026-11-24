import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export async function openReaderActionSheet(page) {
  const chapterTitle = await page.locator('.un-reader-title strong').innerText();
  await page.getByRole('button', { name: '리더 추가 메뉴', exact: true }).click();
  return page.getByRole('dialog', { name: chapterTitle, exact: true });
}

export async function openReaderLookTab(page) {
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const tab = settings.getByRole('tab', { name: /^리더 보기/u });
  await settings.waitFor();
  if (await tab.isVisible()) await tab.click();
  await settings.getByRole('heading', { name: '리더 보기', exact: true }).waitFor();
  return settings;
}

/** Shared real-UI proof for the browser and the native WebView. Starts inside a text book. */
export async function verifyReaderControls(page, { font = false, captureSelection } = {}) {
  page.setDefaultTimeout(30_000);
  console.log('Checking reader controls and selection');
  const root = page.locator('.reader-viewport-layer.is-active');
  const center = async () => {
    const rect = await root.boundingBox();
    assert(rect, 'Active reader viewport is missing');
    await root.click({ position: { x: rect.width / 2, y: rect.height / 2 } });
  };
  if (await page.locator('.reader-screen.immersive').count()) await center();
  await page.waitForTimeout(3000);
  assert.equal(await page.locator('.reader-screen.chrome-visible').count(), 1, 'Reader controls auto-hid');
  const highlight = page.getByRole('button', { name: '선택 문장 하이라이트', exact: true });
  if (await highlight.isVisible()) {
    assert.equal(await highlight.isDisabled(), true);
  }
  const actions = await openReaderActionSheet(page);
  const inactiveHighlight = actions.getByRole('button', { name: '하이라이트 (문장을 먼저 선택)', exact: true });
  assert.equal(await inactiveHighlight.isDisabled(), true);
  await actions.getByRole('button', { name: '자동 읽기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자동 읽기', exact: true });
  await dialog.getByRole('combobox', { name: '자동 읽기 방식', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await center();
  await page.locator('.reader-screen.immersive').waitFor();
  const select = () =>
    root.evaluate((element) => {
      const nodes = [...element.querySelectorAll('[data-reader-text]')]
        .filter((node) => node.textContent.trim().length > 3)
        .slice(0, 2);
      if (nodes.length !== 2) throw new Error('Selection fixture needs two visible paragraphs');
      const first = document.createTreeWalker(nodes[0], NodeFilter.SHOW_TEXT).nextNode();
      const walker = document.createTreeWalker(nodes[1], NodeFilter.SHOW_TEXT);
      let last;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
      window.getSelection().setBaseAndExtent(first, 1, last, last.textContent.length - 1);
    });
  await select();
  const toolbar = page.getByRole('toolbar', { name: /^[\d,]+자 선택$/u });
  await toolbar.getByRole('button', { name: '노랑 하이라이트', exact: true }).click();
  await page.waitForFunction(() => {
    const marks = document.querySelectorAll('.reader-viewport-layer.is-active .reader-inline-highlight');
    return new Set([...marks].map((mark) => mark.closest('[data-reader-text]')).filter(Boolean)).size >= 2;
  });
  await toolbar.waitFor({ state: 'hidden' });
  await select();
  const remove = toolbar.getByRole('button', { name: '선택 범위의 하이라이트 삭제', exact: true });
  await remove.waitFor();
  const bar = await toolbar.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  assert(
    bar && bar.x >= 0 && bar.y >= 0 && bar.x + bar.width <= viewport.width && bar.y + bar.height <= viewport.height,
    'Selection toolbar leaves viewport',
  );
  await captureSelection?.();
  await remove.click();
  await page.waitForFunction(
    () => !document.querySelector('.reader-viewport-layer.is-active .reader-inline-highlight'),
  );
  await toolbar.waitFor({ state: 'hidden' });
  console.log('Reader selection and controls passed');
  if (font) {
    console.log('Checking reader font installation');
    await center();
    const openFontSettings = async () => {
      const actions = await openReaderActionSheet(page);
      await actions.getByRole('button', { name: '전체 읽기 설정', exact: true }).click();
      return openReaderLookTab(page);
    };
    const settings = await openFontSettings();
    const activeFont = settings.locator('.un-user-font-list .is-active');
    const close = settings.getByRole('button', { name: '설정 닫기', exact: true });
    const require = createRequire(import.meta.url);
    await settings
      .locator('.un-user-fonts input[type="file"]')
      .setInputFiles(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    await activeFont.waitFor();
    await close.click();
    await page.waitForFunction(() =>
      [...document.fonts].some((face) => face.family.includes('Boaa User ') && face.status === 'loaded'),
    );
    await openFontSettings();
    await activeFont.getByRole('button', { name: / 지우기$/u }).click();
    await page
      .getByRole('dialog', { name: '글꼴을 지울까요?', exact: true })
      .getByRole('button', { name: '지우기', exact: true })
      .click();
    await settings.locator('.un-user-font-list').waitFor({ state: 'hidden' });
    await close.click();
    console.log('Reader font installation, activation and removal passed');
  }
  return {
    selectionSavedAndRemoved: true,
    chromeLatched: true,
    autoScrollEntry: true,
    userFontInstalledAndRemoved: font,
  };
}
