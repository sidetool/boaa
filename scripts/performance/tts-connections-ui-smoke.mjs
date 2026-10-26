import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright-core';

// Actual UI, sheet and HTTP client; account API is synthetic. Never contacts a TTS provider.
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = process.env.TTS_CONNECTION_UI_ARTIFACTS || '/tmp/boaa-tts-connections-ui';
await mkdir(artifacts, { recursive: true });
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import Connections from '${root}src/ui-next/reader/UiNextTTSConnections.tsx';
import {Sheet} from '${root}src/ui-next/components/primitives.tsx';
import {RemoteApiClient} from '${root}src/services/remote/remote-api-client.ts';
import {createTTSConnectionsPort} from '${root}src/services/remote/tts-connections-client.ts';
import '${root}src/styles/base.css';import '${root}src/ui-next/styles/tokens.css';import '${root}src/ui-next/styles/kit.css';
const port=createTTSConnectionsPort(new RemoteApiClient('/api',{getAuthToken:()=> 'fixture'}));
createRoot(document.getElementById('root')).render(<div className="ui-next"><Sheet open title="TTS 엔진 연결" onClose={()=>{}}><div className="un-listen"><Connections port={port} onChanged={()=>{window.changed=(window.changed||0)+1;}}/></div></Sheet></div>);`;
const { output } = await build({
  root,
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'tts-connections-fixture',
      resolveId: (id) => (id === 'fixture' ? '\0fixture.tsx' : undefined),
      load: async (id) =>
        id === '\0fixture.tsx'
          ? (await transformWithEsbuild(source, 'fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code
          : undefined,
    },
  ],
  build: { write: false, rollupOptions: { input: 'fixture' } },
});
const entry = output.find((asset) => asset.isEntry);
let connections = [];
const calls = [];
let sequence = 0;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: pathname, body });
    res.setHeader('Content-Type', 'application/json');
    if (pathname.endsWith('/probe')) {
      if (body.apiKey === 'bad-fixture') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: '인증하지 못했어요. API 키를 확인해 주세요.' }));
      }
      return res.end(
        JSON.stringify(
          body.protocol === 'local'
            ? { models: ['local-model'], voices: [{ id: 'local-speaker', label: '차분한 목소리', lang: 'ko' }] }
            : { models: [], voices: [] },
        ),
      );
    }
    if (req.method === 'GET') return res.end(JSON.stringify({ connections }));
    const id = pathname.split('/').at(-1);
    if (req.method === 'DELETE') {
      connections = connections.filter((c) => c.id !== id);
      return res.end('{}');
    }
    const old = connections.find((c) => c.id === id);
    const { apiKey, ...rest } = body;
    const saved = {
      ...rest,
      id: old?.id || 'fixture-' + ++sequence,
      hasApiKey: apiKey === undefined ? !!old?.hasApiKey : !!apiKey,
      revision: 'fixture',
    };
    connections = [...connections.filter((c) => c.id !== saved.id), saved];
    return res.end(JSON.stringify(saved));
  }
  const asset = output.find((x) => '/' + x.fileName === pathname);
  res.setHeader('Content-Type', asset ? (asset.type === 'chunk' ? 'application/javascript' : 'text/css') : 'text/html');
  res.end(
    asset
      ? (asset.code ?? asset.source)
      : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${output
          .filter((x) => x.fileName.endsWith('.css'))
          .map((x) => `<link rel="stylesheet" href="/${x.fileName}">`)
          .join(
            '',
          )}<body style="margin:0;background:#101012"><div id="root"></div><script type="module" src="/${entry.fileName}"></script>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const checks = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_UI_BROWSER_EXECUTABLE });
  for (const width of [320, 390, 1280]) {
    connections = [];
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByText('저장된 서버가 없어요.').waitFor();
    await page.getByRole('button', { name: '서버 추가', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill('집 PC');
    await page.getByLabel('주소', { exact: true }).fill('http://127.0.0.1:9011');
    await page.getByRole('button', { name: '연결 확인', exact: true }).click();
    await page.getByText(/모델 1개, 목소리 1개/).waitFor();
    assert.equal(await page.getByLabel('모델 ID', { exact: true }).inputValue(), 'local-model');
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(
      await page
        .locator('.un-tts-conn-editor input:not([type=checkbox]), .un-tts-conn-editor textarea')
        .evaluateAll((nodes) =>
          nodes.every((el) => {
            const a = el.getBoundingClientRect(),
              b = el.parentElement.getBoundingClientRect();
            return getComputedStyle(el).boxSizing === 'border-box' && a.left >= b.left - 1 && a.right <= b.right + 1;
          }),
        ),
      true,
    );
    await page.screenshot({ path: `${artifacts}/local-${width}.png` });
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: '집 PC 수정' }).waitFor();
    assert.equal(connections.length, 1);
    assert.equal(connections[0].protocol, 'local');
    await page.getByRole('button', { name: '서버 추가', exact: true }).click();
    await page.getByRole('radio', { name: 'OpenAI 호환', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill('호환 API');
    await page.getByLabel('주소', { exact: true }).fill('https://tts.example/v1');
    await page.getByLabel('API 키 (선택)', { exact: true }).fill('bad-fixture');
    await page.getByRole('button', { name: '연결 확인', exact: true }).click();
    await page.getByText(/인증하지 못했어요/).waitFor();
    await page.getByLabel('API 키 (선택)', { exact: true }).fill('test-only-key');
    await page.getByRole('button', { name: '연결 확인', exact: true }).click();
    await page.getByText(/이 서버는 모델·목소리 목록을 알려주지 않아요/).waitFor();
    await page.getByLabel('모델 ID', { exact: true }).fill('compatible-model');
    await page.getByLabel('목소리', { exact: true }).fill('alloy, 차분한 목소리, ko');
    await page.getByText('고급 설정', { exact: true }).click();
    await page.evaluate(() => document.activeElement?.blur());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(
      await page
        .locator('.un-tts-conn-editor input:not([type=checkbox]), .un-tts-conn-editor textarea')
        .evaluateAll((nodes) =>
          nodes.every((el) => {
            const a = el.getBoundingClientRect(),
              b = el.parentElement.getBoundingClientRect();
            return getComputedStyle(el).boxSizing === 'border-box' && a.left >= b.left - 1 && a.right <= b.right + 1;
          }),
        ),
      true,
    );
    await page.screenshot({ path: `${artifacts}/openai-${width}.png` });
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: '호환 API 수정' }).waitFor();
    const saved = connections.find((c) => c.name === '호환 API');
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.paid, true);
    await page.getByRole('switch', { name: '호환 API 사용' }).click();
    await page.waitForFunction(() => window.changed >= 3);
    assert.equal(connections.find((c) => c.id === saved.id).enabled, false);
    assert.equal(connections.find((c) => c.id === saved.id).hasApiKey, true);
    await page.getByRole('button', { name: '호환 API 수정' }).click();
    assert.equal(await page.getByLabel('API 키 (선택)', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await page
      .getByRole('group', { name: '서버 삭제 확인' })
      .getByRole('button', { name: '삭제', exact: true })
      .click();
    await page.getByRole('button', { name: '서버 추가', exact: true }).waitFor();
    assert.equal(connections.length, 1);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    checks.push({
      width,
      localDiscovery: true,
      openaiManual: true,
      authError: true,
      preserveKeyOnToggle: true,
      delete: true,
      noOverflow: true,
    });
    await context.close();
  }
  assert.equal(errors.length, 0);
  assert.equal(
    calls.some((c) => c.path.includes('synthesize') || c.path.includes('audio/speech')),
    false,
  );
  await writeFile(
    `${artifacts}/result.json`,
    JSON.stringify({ ok: true, checks, errors, syntheticApi: true, browserClosed: true }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks: checks.length, errors, artifacts }));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
