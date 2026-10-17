import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { imageSource } from '../../apps/server/src/extensions/mangayomi/fixtures/synthetic-sources';
import type { Page } from 'playwright-core';
import { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import type { compatibilityHttp } from '../../apps/server/src/extensions/mangayomi/http';

export async function prepareMangayomiAppGate(_root: string, output: string, options: { live?: boolean } = {}) {
  if (options.live) throw new Error('live_source_checks_are_private');
  const file = resolve(output, 'synthetic-images.js');
  await writeFile(file, imageSource);
  const calls: string[] = [];
  let png = Buffer.alloc(0);
  const fixtureTransport: typeof compatibilityHttp = async ({ url }) => {
    calls.push(url);
    const parsed = new URL(url);
    let data: unknown;
    if (parsed.hostname === 'images.example' && parsed.pathname === '/data/fixture/page.png')
      return { url, bytes: png, headers: {}, contentType: 'image/png', statusCode: 200 };
    if (parsed.hostname !== 'catalog.example') throw Error('unexpected_fixture_request');
    if (parsed.pathname === '/works')
      data = {
        list:
          parsed.searchParams.get('title') === 'missing' ? [] : [{ name: 'Synthetic image work', link: '/works/work' }],
        hasNextPage: false,
      };
    else if (parsed.pathname === '/works/work')
      data = {
        description: 'Offline synthetic source app test',
        chapters: [{ name: 'Ch.1 Fixture chapter', url: '/chapters/chapter/pages' }],
      };
    else if (parsed.pathname === '/chapters/chapter/pages')
      data = { pages: ['https://images.example/data/fixture/page.png'] };
    else throw Error('unexpected_fixture_request');
    return {
      url,
      bytes: Buffer.from(JSON.stringify(data)),
      headers: {},
      contentType: 'application/json',
      statusCode: 200,
    };
  };
  const host = await MangayomiExtensionHost.open(
    resolve(output, 'mangayomi'),
    new EncryptedSourceCredentialVault(resolve(output, 'vault'), Buffer.alloc(32, 11)),
    fixtureTransport,
  );
  return {
    host,
    file,
    calls,
    setImage: (bytes: Buffer) => {
      png = Buffer.from(bytes);
    },
  };
}
export async function runMangayomiAppGate(
  page: Page,
  fixture: Awaited<ReturnType<typeof prepareMangayomiAppGate>>,
  output: string,
  options: { live?: boolean } = {},
) {
  if (options.live) throw new Error('live_source_checks_are_private');
  page.on('response', async (response) => {
    if (response.url().includes('/api/') && response.status() >= 400)
      console.error('Mangayomi fixture API failure', response.status(), await response.text());
  });
  // A visible, owned page makes the reader screenshot meaningful; no upstream artwork is retained.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f4f0e4';
    ctx.fillRect(0, 0, 320, 480);
    ctx.fillStyle = '#29465b';
    ctx.fillRect(20, 20, 280, 200);
    ctx.fillStyle = '#77966d';
    ctx.fillRect(20, 240, 130, 170);
    ctx.fillStyle = '#c87b52';
    ctx.fillRect(170, 240, 130, 170);
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px sans-serif';
    ctx.fillText('Synthetic JS source', 40, 100);
    ctx.fillText('Boaa reader fixture', 40, 140);
    ctx.fillStyle = '#29465b';
    ctx.font = '16px sans-serif';
    ctx.fillText('320 x 480 / locally generated', 35, 448);
    return canvas.toDataURL('image/png');
  });
  fixture.setImage(Buffer.from(dataUrl.split(',')[1], 'base64'));
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  await page.getByRole('tab', { name: /^콘텐츠 소스/ }).click();
  await page.getByRole('button', { name: 'Mangayomi JS 확장', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Mangayomi JS 확장 관리', exact: true });
  await panel.getByLabel('Mangayomi JS 확장 파일', { exact: true }).setInputFiles(fixture.file);
  await panel.getByLabel('파일의 소스 선택').selectOption('1');
  const review = panel.getByRole('region', { name: 'Mangayomi JS 설치 확인', exact: true });
  await review.getByLabel('신뢰하는 확장입니다').check();
  await review.getByRole('button', { name: '설치', exact: true }).click();
  await panel.getByRole('button', { name: '끄기', exact: true }).waitFor();
  await panel.getByRole('button', { name: '설정', exact: true }).click();
  const languages = panel.getByLabel('Filter original languages', { exact: true });
  await languages.selectOption(['originalLanguage[]=ko', 'originalLanguage[]=ja']);
  await panel.getByRole('button', { name: '설정 저장', exact: true }).click();
  await panel.getByText('저장했습니다.', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'mangayomi-preferences.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: '연결된 외부 소스' })
    .getByRole('button', { name: /Synthetic images/ })
    .click();
  const work = page.getByRole('button', { name: 'Synthetic image work 작품 상세 열기', exact: true });
  await work.waitFor();
  if (
    !fixture.calls.some((url) =>
      ['ko', 'ja'].every((lang) => new URL(url).searchParams.getAll('originalLanguage[]').includes(lang)),
    )
  )
    throw Error('saved_language_not_applied');
  await page.locator('.source-hub-catalog-search input').fill('missing');
  await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
  await work.waitFor({ state: 'detached' });
  await page.locator('.source-hub-catalog-search input').fill('Fixture');
  await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
  await work.waitFor();
  await work.click();
  await page.locator('.source-hub-release-row').first().waitFor();
  await page.getByLabel('이 페이지 선택', { exact: true }).check();
  await page.getByRole('button', { name: '선택 회차 다운로드', exact: true }).click();
  const imported = page.locator('.source-hub-release-row[data-state="imported"]');
  await imported.first().waitFor({ timeout: 30000 });
  await imported.getByRole('button', { name: 'Ch.1 Fixture chapter 보기', exact: true }).click();
  await page.locator('.fixed-doc-screen').waitFor();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('.fixed-doc-screen img')).some(
      (img) => img.complete && img.naturalWidth === 320 && img.naturalHeight === 480,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'mangayomi-reader-390.png'), fullPage: true });
  if (!fixture.calls.some((url) => url.endsWith('/page.png'))) throw Error('image_not_downloaded');
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.reload();
  await page
    .getByRole('navigation', { name: '연결된 외부 소스' })
    .getByRole('button', { name: /Synthetic images/ })
    .click();
  await work.click();
  await imported.getByRole('button', { name: 'Ch.1 Fixture chapter 보기', exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('.fixed-doc-screen img')).some(
      (img) => img.complete && img.naturalWidth === 320 && img.naturalHeight === 480,
    ),
  );
  if (fixture.calls.filter((url) => url.endsWith('/page.png')).length !== 1)
    throw Error('reopen_redownloaded_imported_image');

  const pkg = fixture.host.snapshot().packages[0].pkg;
  const fields = fixture.host.preferences(pkg).fields;
  if (
    JSON.stringify([...(fields.find((f) => f.key === 'original_languages')?.value as string[])].sort()) !==
    JSON.stringify(['originalLanguage[]=ja', 'originalLanguage[]=ko'])
  )
    throw Error('preferences_not_saved');
  console.log(
    JSON.stringify({
      passed: true,
      target: 'hosted synthetic Mangayomi source + deterministic offline HTTP',
      coverage:
        'UI file import/language selection, multiple preferences, catalog search, chapter download, comic reader image decode, reload/reopen without redownload',
      output,
    }),
  );
}
