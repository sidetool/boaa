import { mangayomiWebViewScript } from './mangayomi/webview-script.js';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { browserEngine, browserLauncher } from '@boaa/browser-runtime';
import { launchSourceBrowser, sourceBrowserUsesRemote } from './source-browser-launch.js';
import { SourceWebViewHost, sourceWebViewHost } from './source-webview.js';
import { sourceBrowserHttp } from './source-browser-cookies.js';

describe.skipIf(!process.env.BOAA_TEST_SOURCE_BROWSER)('production source WebView', { timeout: 30000 }, () => {
  const host = new SourceWebViewHost({ idleMs: 0 });
  const secrets = new Map<string, { secret: string }>();
  const vault = {
    read: (key: string) => secrets.get(key),
    write: (key: string, value?: { secret: string }) => {
      if (value) secrets.set(key, value);
      else secrets.delete(key);
    },
  };
  let server: Server, origin: string;
  let receivedRequests = 0;
  const scope = (key = 'one') => ({ key, vault, privateOrigins: [origin], origins: [origin] });
  beforeAll(async () => {
    server = createServer((request, response) => {
      receivedRequests++;
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/reader' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><body><div id="reader"></div><script>setTimeout(()=>{document.querySelector("#reader").textContent="첫 줄\\n둘째 줄"},80)</script></body></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('executes delayed site JS, follows browser redirects and preserves text', async () => {
    const result = await host.evaluate(
      {
        url: origin + '/redirect',
        script: `new Promise(resolve=>{
      const timer=setInterval(()=>{const text=document.querySelector('#reader').textContent;
      if(text){clearInterval(timer);resolve({text,path:location.pathname})}},20)})`,
      },
      scope(),
      AbortSignal.timeout(15000),
    );
    expect(result).toEqual({ text: '첫 줄\n둘째 줄', path: '/reader' });
  });
  it('restores cookies and storage only within the same source', async () => {
    await host.evaluate(
      {
        url: origin,
        script: `(()=>{document.cookie='session=one; Path=/';localStorage.setItem('saved','yes');return true})()`,
      },
      scope(),
      AbortSignal.timeout(15000),
    );
    const request = { url: origin, script: `({cookie:document.cookie,saved:localStorage.getItem('saved')})` };
    expect(await host.evaluate(request, scope(), AbortSignal.timeout(15000))).toEqual({
      cookie: 'session=one',
      saved: 'yes',
    });
    let cookie = '';
    await sourceBrowserHttp({ url: origin }, AbortSignal.timeout(1000), scope(), 1024, async (input) => {
      cookie = input.headers?.cookie ?? '';
      return {
        statusCode: 200,
        bytes: Buffer.from('ok'),
        headers: { 'set-cookie': ['fromHttp=yes; Path=/'] },
        contentType: 'text/plain',
        url: origin,
      };
    });
    expect(cookie).toBe('session=one');
    expect(
      await host.evaluate({ url: origin, script: 'document.cookie' }, scope(), AbortSignal.timeout(15000)),
    ).toContain('fromHttp=yes');
    expect(await host.evaluate(request, scope('two'), AbortSignal.timeout(15000))).toEqual({ cookie: '', saved: null });
  });
  it('blocks navigation and subrequests outside the source grant', async () => {
    await expect(
      host.evaluate(
        { url: origin, script: 'true' },
        { ...scope(), origins: [], privateOrigins: [] },
        AbortSignal.timeout(15000),
      ),
    ).rejects.toThrow('source_url_denied');
    const result = await host.evaluate(
      { url: origin, script: `fetch('http://localhost:1/secret').then(()=>false,()=>true)` },
      scope(),
      AbortSignal.timeout(15000),
    );
    expect(result).toBe(true);
  });
  it('cancels a pending evaluation and releases its source slot', async () => {
    const abort = new AbortController();
    const pending = host.evaluate({ url: origin, script: 'new Promise(()=>{})' }, scope(), abort.signal);
    setTimeout(() => abort.abort(), 400);
    await expect(pending).rejects.toThrow('cancelled');
    expect(await host.evaluate({ url: origin, script: '42' }, scope(), AbortSignal.timeout(15000))).toBe(42);
  });
  it('routes loopback through the guarded proxy and requires an explicit private-origin grant', async () => {
    const before = receivedRequests;
    await expect(
      host.evaluate(
        { url: origin, script: 'true' },
        { key: 'no-private-grant', origins: [origin], privateOrigins: [] },
        AbortSignal.timeout(15000),
      ),
    ).rejects.toThrow(/source_(?:url|address)_denied/);
    expect(receivedRequests).toBe(before);
  });
  it('keeps a different source running when one concurrent browser job is cancelled', async () => {
    const abort = new AbortController();
    const stopped = host.evaluate({ url: origin, script: 'new Promise(()=>{})' }, scope('cancel-one'), abort.signal);
    const cancellation = expect(stopped).rejects.toThrow('cancelled');
    const kept = host.evaluate(
      { url: origin, script: 'new Promise(resolve=>setTimeout(()=>resolve("kept"),800))' },
      scope('keep-other'),
      AbortSignal.timeout(15000),
    );
    setTimeout(() => abort.abort(), 500);
    await cancellation;
    expect(await kept).toBe('kept');
  });
  it('keeps caller credentials on their origin across a redirect to another granted origin', async () => {
    let authorization: string | undefined;
    let customToken: string | undefined;
    let initialAuthorization: string | undefined;
    const target = createServer((request, response) => {
      authorization = request.headers.authorization;
      customToken = request.headers['x-api-key'] as string | undefined;
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Target</title>');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetOrigin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const redirect = createServer((request, response) => {
      initialAuthorization = request.headers.authorization;
      response.writeHead(302, { location: targetOrigin }).end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    const redirectOrigin = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
    try {
      await host.evaluate(
        {
          url: redirectOrigin,
          headers: { Authorization: 'Bearer synthetic-only', 'X-Api-Key': 'synthetic-custom' },
          script: 'document.title',
        },
        {
          key: 'redirect-isolation',
          origins: [redirectOrigin, targetOrigin],
          privateOrigins: [redirectOrigin, targetOrigin],
        },
        AbortSignal.timeout(15000),
      );
      expect(authorization).toBeUndefined();
      expect(customToken).toBeUndefined();
      expect(initialAuthorization).toBe('Bearer synthetic-only');
      const response = await host.request(
        { url: redirectOrigin, headers: { Authorization: 'Bearer synthetic-only', 'X-Api-Key': 'synthetic-custom' } },
        {
          key: 'http-redirect-isolation',
          origins: [redirectOrigin, targetOrigin],
          privateOrigins: [redirectOrigin, targetOrigin],
        },
        AbortSignal.timeout(15000),
        1024,
        true,
      );
      expect(response.statusCode).toBe(200);
      expect(authorization).toBeUndefined();
      expect(customToken).toBeUndefined();
      expect(initialAuthorization).toBe('Bearer synthetic-only');
    } finally {
      redirect.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => redirect.close(() => done())),
        new Promise<void>((done) => target.close(() => done())),
      ]);
    }
  });
  it('supports maker callbacks and shares the selected browser identity with HTTP requests', async () => {
    for (const browserMode of ['camoufox'] as const) {
      const current = { ...scope('engine-' + browserMode), browserMode };
      const script = mangayomiWebViewScript([
        `(async()=>{
          const iv=crypto.getRandomValues(new Uint8Array(12));
          const key=await crypto.subtle.importKey('raw',new Uint8Array(16),'AES-GCM',false,['encrypt','decrypt']);
          const bytes=new TextEncoder().encode('본문 이미지 키');
          const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes);
          const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,encrypted);
          document.cookie='callback=done; Path=/';
          window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({
            ok:true,ua:navigator.userAgent,decoded:new TextDecoder().decode(plain)
          }));
        })().catch(error=>window.flutter_inappwebview.callHandler('setResponse',JSON.stringify({error:String(error)})))`,
      ]);
      const result = JSON.parse(
        (await host.evaluate(
          { url: origin, script, waitUntil: 'load', headers: { 'User-Agent': 'Boaa-test-agent' } },
          current,
          AbortSignal.timeout(15000),
        )) as string,
      );
      expect(result.ok).toBe(true);
      expect(result.decoded).toBe('본문 이미지 키');
      expect(result.ua).toContain(browserEngine() === 'camoufox' ? 'Firefox/' : 'Chrome/');
      expect(result.ua).not.toBe('Boaa-test-agent');
      await sourceBrowserHttp({ url: origin }, AbortSignal.timeout(1000), current, 1024, async (input) => {
        expect(input.headers).toMatchObject({ cookie: 'callback=done', 'user-agent': result.ua });
        return { statusCode: 200, headers: {}, bytes: Buffer.from('ok'), contentType: 'text/plain', url: origin };
      });
    }
  });
  it('finishes a same-URL challenge reload, then uses real HTTP with maker headers and saved identity', async () => {
    let browserAgent = '';
    let challenges = 0;
    const fixture = createServer((request, response) => {
      if (request.headers.cookie?.includes('verified=yes') && request.headers['user-agent'] === browserAgent) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      challenges++;
      if (request.headers['user-agent']?.includes(browserEngine() === 'camoufox' ? 'Firefox/' : 'Chrome/'))
        browserAgent = request.headers['user-agent'];
      response
        .writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' })
        .end('<script>document.cookie="verified=yes; Path=/";location.reload();</script>');
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const current = {
      ...scope('http-clearance'),
      origins: [target],
      privateOrigins: [target],
      browserAllowed: true,
      browserUsage: 'http-first' as const,
    };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await sourceBrowserHttp(
          {
            url: target,
            headers: { 'User-Agent': 'Maker Chrome UA', Cookie: 'maker=yes' },
            options: { timeout: 25 },
          },
          AbortSignal.timeout(30000),
          current,
          1024,
        );
        expect(response.statusCode).toBe(200);
        expect(response.bytes.toString()).toBe('{"ok":true}');
      }
      expect(challenges).toBe(2); // One HTTP denial and one browser challenge; no repeated authentication.
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
  it('learns a browser-only path with real networking and skips later HTTP failures', async () => {
    let httpDenied = 0;
    const fixture = createServer((request, response) => {
      if (!request.headers['sec-fetch-mode']) {
        httpDenied++;
        response.writeHead(403, { 'cf-mitigated': 'challenge' }).end('challenge');
      } else response.writeHead(200, { 'content-type': 'text/plain' }).end('browser document');
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const current = {
      ...scope('learned-browser-route'),
      origins: [target],
      privateOrigins: [target],
      browserAllowed: true,
    };
    try {
      for (let page = 1; page <= 3; page++) {
        const response = await sourceBrowserHttp(
          { url: `${target}/catalog?page=${page}`, options: { timeout: 25 } },
          AbortSignal.timeout(30000),
          current,
          1024,
        );
        expect(response.statusCode).toBe(200);
        expect(response.bytes.toString()).toBe('browser document');
        expect(httpDenied).toBe(2);
      }
    } finally {
      await sourceWebViewHost.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
  it('reuses Patchright beyond eight calls, bounds Camoufox and closes the final browser after idle', async () => {
    const warm = new SourceWebViewHost({ idleMs: 250, hasQueuedClients: async () => false });
    const launcher = warm as unknown as { launch(engine: string, signal?: AbortSignal): Promise<Browser> };
    const original = launcher.launch.bind(warm);
    const browsers: Browser[] = [];
    const launch = vi.spyOn(launcher, 'launch').mockImplementation(async (...args) => {
      const browser = await original(...args);
      browsers.push(browser);
      return browser;
    });
    try {
      for (let i = 0; i < 10; i++)
        expect(await warm.evaluate({ url: origin, script: '42' }, scope('warm-' + i), AbortSignal.timeout(15000))).toBe(
          42,
        );
      expect(new Set(browsers).size).toBe(browserEngine() === 'camoufox' ? 2 : 1);
      if (browserEngine() === 'camoufox') expect(browsers[0].isConnected()).toBe(false);
      const last = browsers.at(-1)!;
      expect(last.contexts()).toHaveLength(0);
      expect(last.isConnected()).toBe(true);
      await vi.waitFor(() => expect(last.isConnected()).toBe(false), { timeout: 5000 });
    } finally {
      launch.mockRestore();
      await warm.close();
    }
  });
  it('yields an idle browser when another runtime client is waiting', async () => {
    let queued = false;
    const warm = new SourceWebViewHost({ idleMs: 60000, queueCheckMs: 30, hasQueuedClients: async () => queued });
    const launcher = warm as unknown as { launch(engine: string, signal?: AbortSignal): Promise<Browser> };
    const original = launcher.launch.bind(warm);
    let browser: Browser | undefined;
    const launch = vi
      .spyOn(launcher, 'launch')
      .mockImplementation(async (...args) => (browser = await original(...args)));
    try {
      await warm.evaluate({ url: origin, script: 'true' }, scope('warm-yield'), AbortSignal.timeout(15000));
      expect(browser?.isConnected()).toBe(true);
      queued = true;
      await vi.waitFor(() => expect(browser?.isConnected()).toBe(false), { timeout: 5000 });
    } finally {
      launch.mockRestore();
      await warm.close();
    }
  });
  it('recycles a busy browser after its use budget without retaining closed contexts', async () => {
    const warm = new SourceWebViewHost({ idleMs: 60000, maxUses: 2, hasQueuedClients: async () => false });
    const launcher = warm as unknown as { launch(engine: string, signal?: AbortSignal): Promise<Browser> };
    const original = launcher.launch.bind(warm);
    const browsers: Browser[] = [];
    const launch = vi.spyOn(launcher, 'launch').mockImplementation(async (...args) => {
      const browser = await original(...args);
      browsers.push(browser);
      return browser;
    });
    try {
      for (let i = 0; i < 3; i++)
        expect(
          await warm.evaluate({ url: origin, script: '42' }, scope('budget-' + i), AbortSignal.timeout(15000)),
        ).toBe(42);
      expect(browsers[0]).toBe(browsers[1]);
      expect(browsers[0].isConnected()).toBe(false);
      expect(browsers[2]).not.toBe(browsers[0]);
      expect(browsers[2].isConnected()).toBe(true);
      expect(browsers[2].contexts()).toHaveLength(0);
    } finally {
      launch.mockRestore();
      await warm.close();
    }
  });
  it.skipIf(!sourceBrowserUsesRemote())(
    'allows a real second client to acquire the remote runtime while the API is idle',
    async () => {
      const warm = new SourceWebViewHost({ idleMs: 60000, queueCheckMs: 100 });
      let other: Browser | undefined;
      try {
        await warm.evaluate({ url: origin, script: 'true' }, scope('remote-warm-yield'), AbortSignal.timeout(15000));
        other = await launchSourceBrowser(
          await browserLauncher(),
          [],
          process.platform,
          browserEngine(),
          AbortSignal.timeout(15000),
        );
        expect(other.isConnected()).toBe(true);
      } finally {
        await other?.close();
        await warm.close();
      }
    },
  );
  it('uses browser HTTP for raw bytes, one POST, HEAD, bounded bodies and explicit redirect policy', async () => {
    const exact = Buffer.from('\uFEFF{ "title": "합성", "spacing": "  " }\r\n');
    let posts = 0,
      receivedBody = '',
      followed = 0;
    const fixture = createServer(async (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/target' }).end();
        return;
      }
      if (request.url === '/target') followed++;
      if (request.method === 'POST') {
        posts++;
        for await (const chunk of request) receivedBody += chunk;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'raw=kept; Path=/' });
      response.end(exact);
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const current = { ...scope('browser-http'), origins: [target], privateOrigins: [target] };
    try {
      const request = (path: string, method = 'GET', maximum = 1024, follow = false) =>
        host.request(
          {
            url: target + path,
            method,
            ...(method === 'POST'
              ? { body: 'query=synthetic', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
              : {}),
          },
          current,
          AbortSignal.timeout(15000),
          maximum,
          follow,
        );
      const raw = await request('/');
      expect(raw.bytes).toEqual(exact);
      expect((await request('/', 'POST')).statusCode).toBe(200);
      expect(posts).toBe(1);
      expect(receivedBody).toBe('query=synthetic');
      expect((await request('/', 'HEAD')).bytes.length).toBe(0);
      expect((await request('/redirect')).statusCode).toBe(302);
      expect(followed).toBe(0);
      expect((await request('/redirect', 'GET', 1024, true)).url).toBe(target + '/target');
      expect(followed).toBe(1);
      await expect(request('/', 'GET', 4)).rejects.toThrow('source_body_limit');
    } finally {
      fixture.closeAllConnections();
      await new Promise<void>((done) => fixture.close(() => done()));
    }
  }, 90000);
});
