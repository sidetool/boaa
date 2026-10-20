import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserEngine, browserLauncher } from '@boaa/browser-runtime';
import assert from 'node:assert/strict';
import { createBrowserWorker } from './browser-worker.mjs';

const token = 'a'.repeat(64);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
// This isolated fixture has no user credentials. Production never prints launch failures.
const worker = await createBrowserWorker({ token, onLaunchFailure: (error) => console.error(error.message) });
const fixture = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<html><body><p id="value">synthetic document</p></body></html>');
});
fixture.listen(0, '127.0.0.1');
worker.server.listen(0, '127.0.0.1');
await Promise.all([once(fixture, 'listening'), once(worker.server, 'listening')]);
const origin = `http://127.0.0.1:${fixture.address().port}`;
const endpoint = `http://127.0.0.1:${worker.server.address().port}`;
try {
  for (const engine of [browserEngine()]) {
    const launcher = await browserLauncher(engine);
    const response = await fetch(endpoint + '/v1/browsers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 1,
        engine,
        proxyBridge: { origins: [origin], privateOrigins: [origin] },
      }),
      signal: AbortSignal.timeout(35000),
    });
    assert.equal(response.status, 201);
    const lease = await response.json();
    const websocket = endpoint.replace('http:', 'ws:') + lease.wsPath;
    await assert.rejects(launcher.connect(websocket, { timeout: 3000 }));
    const browser = await launcher.connect(websocket, { headers, timeout: 10000 });
    try {
      const context = await browser.newContext({ proxy: lease.proxy, serviceWorkers: 'block', acceptDownloads: false });
      const page = await context.newPage();
      await page.goto(lease.proxyBootstrapUrl);
      await page.goto(origin);
      assert.equal(await page.locator('#value').innerText(), 'synthetic document');
      await page.evaluate("document.cookie='session=first; Path=/';localStorage.setItem('test','first')");
      await assert.rejects(page.goto('http://127.0.0.1:1/denied', { timeout: 3000 }));
      await context.close();
      const second = await browser.newContext({ proxy: lease.proxy });
      const next = await second.newPage();
      await next.goto(origin);
      assert.equal(await next.evaluate('document.cookie'), '');
      assert.equal(await next.evaluate("localStorage.getItem('test')"), null);
      await second.close();
    } finally {
      await browser.close();
    }
    console.log(`${engine}: authenticated remote launch/WebSocket, proxy origin guard and context isolation PASS`);
  }
} finally {
  await worker.close();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
}
