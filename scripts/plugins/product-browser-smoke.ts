import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { loadConfig } from '../../apps/server/src/config';
import { requestCookie, SELF_HOST_SESSION_COOKIE } from '../../apps/server/src/auth-cookie';
import { migrateDatabase } from '../../apps/server/src/db/migrate';
import { seedDefaultUser } from '../../apps/server/src/db/pool';
import { registerPluginRuntimeRoutes } from '../../apps/server/src/routes/plugin-runtime';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from '../../apps/server/src/services/self-host-auth-service';
import {
  startPostgresIntegrationHarness,
  withPostgresSchema,
} from '../../apps/server/src/services/id-v2-migration/postgres-integration-harness';
import { buildPlatformPackage, verifyPlatformSingleJs } from '../../src/extensions/packages/platform-package';

// Uses only synthetic packages, an isolated database, and independent temporary browser profiles.
// The real provider, store, Worker, settings UI, home card and search route run unchanged.
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Fastify = require('fastify') as typeof import('../../apps/server/node_modules/fastify').default;
const { build } = require('esbuild') as typeof import('../../apps/server/node_modules/esbuild');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'boaa-plugin-browser-'));
const assets = join(output, 'runtime');
const runtimeBuilder = new URL('./build-product-runtime.mjs', import.meta.url).href;
await (await import(runtimeBuilder)).buildProductPluginRuntime(assets);
await build({
  entryPoints: [join(root, 'scripts/plugins/product-browser-fixture.tsx')],
  outfile: join(output, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'synthetic-account-context',
      setup(build) {
        build.onResolve({ filter: /SelfHostAccountGate$/ }, () => ({ path: 'synthetic-account', namespace: 'smoke' }));
        build.onLoad({ filter: /.*/, namespace: 'smoke' }, () => ({
          contents:
            "const account={username:'synthetic',displayName:'Synthetic'}; export const useOptionalSelfHostAuth=()=>({account});",
        }));
      },
    },
  ],
});
const header = {
  id: 'fixture.home',
  name: '검증용 추천 작품',
  version: '1.0.0',
  apiVersion: 2,
  license: 'MIT',
  activation: ['onHome'],
  permissions: ['home.feed', 'settings.own', 'storage.own'],
  features: ['home.feed', 'settings.schema', 'storage.own'],
  storageKiB: 8,
  contributes: { homeSections: [{ id: 'today', title: '오늘의 인기 소설' }] },
};
const source = `/* @boaa-plugin ${JSON.stringify(header)} */\nBoaaPlugin.register({apiVersion:2,
 settings:{version:1,fields:{label:{type:'string',label:'목록 제목',default:'별빛 도서관',maxLength:128}}},
 activate(ctx){ctx.home.register('today',async()=>{
   const stored=await ctx.storage.get('shared-author');
   if(stored.found){let conflict;try{await ctx.storage.set('shared-author','잘못된 덮어쓰기',null)}catch(error){conflict=error.message}
     if(conflict!=='STORAGE_CONFLICT')throw Error('Controller conflict code was not preserved');}
   return {items:[{id:'one',title:(await ctx.settings.get()).value.label,author:stored?.value ?? '검증 작가',rank:1}],ttlSeconds:60};
 });}
});`;
const inspected = await verifyPlatformSingleJs(new Blob([source]));
const archive = await buildPlatformPackage({
  manifest: {
    ...inspected.manifest,
    entries: { ...inspected.manifest.entries, ui: { path: 'dist/ui.js', permissions: ['ui.render', 'storage.own'] } },
    activation: ['onHome', 'onView'],
    features: { required: [...inspected.manifest.features.required, 'ui.views'], optional: [] },
    contributes: { ...inspected.manifest.contributes, views: ['panel'] },
  },
  sources: {
    controller: source,
    ui: `BoaaPlugin.register({apiVersion:2,activate(ctx){
      const status=document.createElement('p'); status.textContent='격리 화면 준비 완료'; ctx.view.root.append(status);
      const button=document.createElement('button'); button.textContent='저장소에 기록'; ctx.view.root.append(button);
      button.onclick=async()=>{
        await ctx.storage.set('shared-author','서버 저장 작가');
        let conflict;try{await ctx.storage.set('shared-author','잘못된 덮어쓰기',null)}catch(error){conflict=error.message}
        if(conflict!=='STORAGE_CONFLICT')throw Error('UI conflict code was not preserved');
        status.textContent='저장 완료';
      };
    }});`,
  },
  license: 'Synthetic fixture: MIT',
});
const harness = await startPostgresIntegrationHarness();
if (!harness) throw Error('PostgreSQL test harness unavailable');
try {
  await withPostgresSchema(harness, 'plugin_browser', async (pool) => {
    await migrateDatabase(pool);
    await seedDefaultUser(pool, 'owner');
    const auth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), 'owner');
    const password = 'Synthetic-plugin-browser-password-2026!';
    const account = await auth.register({ username: 'plugin-owner', password });
    const invitation = await auth.invite('owner', 'other-reader');
    await auth.redeem(invitation.token, password, 'invite', 'synthetic-browser');
    const other = await auth.login({ username: 'other-reader', password, throttleKey: 'synthetic-browser' });
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const token = requestCookie(request, SELF_HOST_SESSION_COOKIE);
      const principal = token ? await auth.authenticateSession(token) : undefined;
      if (principal) request.principal = { ...principal, authMethod: 'session' };
    });
    // No JS_PLUGIN_ORIGIN: browser same-origin context and dynamic iframe policy must work by default.
    await registerPluginRuntimeRoutes(
      app,
      loadConfig({ SERVER_DATA_DIR: output, DEFAULT_USER_ID: 'owner' }),
      pool,
      pathToFileURL(assets + '/'),
    );
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body class="ui-next"><div id="root"></div><script type="module" src="/app.js"></script>',
        ),
    );
    for (const file of ['app.js', 'app.css'])
      app.get('/' + file, async (_request, reply) =>
        reply.type(file.endsWith('.css') ? 'text/css' : 'text/javascript').send(await readFile(join(output, file))),
      );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const cache = join(homedir(), '.cache/ms-playwright');
    const installedChromium = (await readdir(cache))
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .at(-1);
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.BOAA_BROWSER_EXECUTABLE ??
        (installedChromium ? join(cache, installedChromium, 'chrome-linux64/chrome') : undefined),
    });
    const errors: string[] = [];
    const open = async (token: string) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
      await context.addCookies([
        { name: SELF_HOST_SESSION_COOKIE, value: token, url: origin, httpOnly: true, sameSite: 'Lax' },
      ]);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.getByTestId('runtime-state').filter({ hasText: '준비됨' }).waitFor();
      return { context, page };
    };
    try {
      const first = await open(account.token);
      await first.page.getByLabel('플러그인 파일', { exact: true }).setInputFiles({
        name: 'synthetic-home.boaaext',
        mimeType: 'application/zip',
        buffer: Buffer.from(await archive.arrayBuffer()),
      });
      await first.page.getByRole('heading', { name: '홈에 작품 표시', exact: true }).waitFor();
      assert.equal(await first.page.getByRole('checkbox').count(), 0);
      await first.page.screenshot({ path: join(output, 'install-review.png'), fullPage: true, animations: 'disabled' });
      await first.page.getByRole('button', { name: '확인하고 설치', exact: true }).click();
      await first.page.getByRole('switch', { name: '검증용 추천 작품 끄기' }).waitFor();
      await first.page.screenshot({
        path: join(output, 'settings-installed.png'),
        fullPage: true,
        animations: 'disabled',
      });
      await first.page.getByRole('button', { name: '플러그인 화면', exact: true }).click();
      await first.page.frameLocator('iframe').getByText('격리 화면 준비 완료', { exact: true }).waitFor();
      await first.page.frameLocator('iframe').getByRole('button', { name: '저장소에 기록', exact: true }).click();
      await first.page.frameLocator('iframe').getByText('저장 완료', { exact: true }).waitFor();
      await first.page.getByRole('button', { name: '닫기', exact: true }).click();
      await first.page.getByRole('button', { name: '홈 보기', exact: true }).click();
      await first.page.getByRole('button', { name: '새로고침', exact: true }).click();
      await first.page.getByRole('button', { name: '별빛 도서관 검색', exact: true }).click();
      await first.page.getByText('서버 저장 작가', { exact: true }).first().waitFor();
      assert.equal(await first.page.getByLabel('검색어', { exact: true }).inputValue(), '별빛 도서관');
      await first.page.screenshot({ path: join(output, 'home-search.png'), fullPage: true });
      await first.page.getByRole('button', { name: '플러그인 설정', exact: true }).click();
      await first.page.getByRole('button', { name: '설정', exact: true }).click();
      await first.page.getByLabel('목록 제목', { exact: true }).fill('기기 간 공유 작품');
      await first.page.getByRole('button', { name: '저장', exact: true }).click();
      await first.page.getByRole('dialog').waitFor({ state: 'hidden' });
      const second = await open(account.token);
      // The second browser doubles as the narrow-viewport visual check.
      await second.page.setViewportSize({ width: 390, height: 844 });
      await second.page.getByRole('switch', { name: '검증용 추천 작품 끄기' }).waitFor();
      await second.page.screenshot({
        path: join(output, 'settings-narrow.png'),
        fullPage: true,
        animations: 'disabled',
      });
      await second.page.getByLabel('플러그인 파일', { exact: true }).setInputFiles({
        name: 'synthetic-home.boaaext',
        mimeType: 'application/zip',
        buffer: Buffer.from(await archive.arrayBuffer()),
      });
      await second.page.getByRole('heading', { name: '홈에 작품 표시', exact: true }).waitFor();
      await second.page.screenshot({ path: join(output, 'review-narrow.png'), animations: 'disabled' });
      await second.page.getByRole('button', { name: '취소', exact: true }).click();
      await second.page.getByRole('dialog').waitFor({ state: 'hidden' });
      await second.page.getByRole('button', { name: '홈 보기', exact: true }).click();
      await second.page.getByRole('button', { name: '기기 간 공유 작품 검색', exact: true }).waitFor();
      await second.page.screenshot({ path: join(output, 'home-narrow.png'), fullPage: true, animations: 'disabled' });
      await second.page.getByRole('button', { name: '기기 간 공유 작품 검색', exact: true }).click();
      await second.page.getByText('서버 저장 작가', { exact: true }).first().waitFor();
      assert.equal(await second.page.getByLabel('검색어', { exact: true }).inputValue(), '기기 간 공유 작품');
      const separate = await open(other.token);
      await separate.page.getByText('설치한 플러그인이 없어요', { exact: true }).waitFor();
      assert.equal(await separate.page.getByText('검증용 추천 작품', { exact: true }).count(), 0);
      await first.page.getByRole('switch', { name: '검증용 추천 작품 끄기' }).click();
      await second.page.getByText('설치된 홈 플러그인이 없습니다.', { exact: true }).waitFor({ timeout: 15000 });
      assert.equal(
        (await second.page.evaluate(() => indexedDB.databases())).filter((db) => db.name?.includes('js-plugins'))
          .length,
        0,
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          ok: true,
          checks: [
            'install capabilities',
            'sandboxed iframe without configured origin',
            'real Worker home feed',
            'card search route',
            'second-browser install/settings',
            'iframe storage write and second-browser Worker storage read',
            'stable storage conflict codes in iframe and Worker',
            'account isolation',
            'cross-browser disable',
            'no plugin IndexedDB',
          ],
          artifacts: output,
        }),
      );
    } finally {
      await browser.close();
      await app.close();
    }
  });
} finally {
  await harness.stop();
}
