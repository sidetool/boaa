import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createSourceBroker } from '@boaa/extension-runtime/source-broker';
import { sourceBrowserSdkSession } from './source-browser-sdk-transport.js';
import { sourceWebViewHost, type SourceWebViewScope } from './source-webview.js';
import { SessionSourceCredentialVault } from './source-credential-vault.js';
import { writeBrowserSession } from './source-browser-session.js';

afterEach(() => vi.restoreAllMocks());
const url = 'https://sdk.example/document';
function scope(usage: SourceWebViewScope['browserUsage'] = 'http-first'): SourceWebViewScope {
  return {
    key: crypto.randomUUID(),
    vault: new SessionSourceCredentialVault(),
    origins: ['https://sdk.example'],
    browserAllowed: true,
    browserUsage: usage,
  };
}
function session(current: SourceWebViewScope) {
  writeBrowserSession(current, {
    origins: [],
    userAgents: { 'https://sdk.example': 'Saved browser identity' },
    cookies: [
      {
        name: 'verified',
        value: 'yes',
        domain: 'sdk.example',
        path: '/',
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ],
  });
}
it('authenticates SDK text once, then streams HTTP with cookies and the saved UA', async () => {
  const current = scope();
  const browser = vi.spyOn(sourceWebViewHost, 'evaluate').mockImplementation(async () => {
    session(current);
    return null;
  });
  const denied: Readable[] = [];
  const received: Record<string, string>[] = [];
  const broker = createSourceBroker(
    { origins: ['https://sdk.example'] },
    {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      session: sourceBrowserSdkSession(current),
      transport: async (_approved, request) => {
        received.push(request.headers);
        const ok =
          request.headers.cookie === 'verified=yes' && request.headers['user-agent'] === 'Saved browser identity';
        const body = Readable.from([ok ? 'exact text\n' : 'challenge']);
        if (!ok) denied.push(body);
        const headers: Record<string, string> = ok ? {} : { 'cf-mitigated': 'challenge' };
        return { status: ok ? 200 : 403, headers, body };
      },
    },
  );
  try {
    for (let i = 0; i < 3; i++)
      expect(await broker.methods['http.request']({ url, response: 'text' }, AbortSignal.timeout(2000))).toEqual({
        text: 'exact text\n',
      });
    expect(browser).toHaveBeenCalledOnce();
    expect(received).toHaveLength(4);
    expect(denied.every((body) => body.destroyed)).toBe(true);
  } finally {
    broker.dispose();
  }
});

it('keeps SDK assets on streaming HTTP with saved sessions even under always mode', async () => {
  const current = scope('always');
  session(current);
  const browser = vi.spyOn(sourceWebViewHost, 'request').mockRejectedValue(new Error('must not launch'));
  const bytes = Buffer.from([1, 2, 3]);
  const broker = createSourceBroker(
    { origins: ['https://sdk.example'], allowDownloads: true },
    {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      session: sourceBrowserSdkSession(current),
      transport: async (_approved, request) => {
        expect(request.headers.cookie).toBe('verified=yes');
        return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Readable.from([bytes]) };
      },
    },
  );
  try {
    const asset = (await broker.methods['http.request']({ url, response: 'asset' }, AbortSignal.timeout(2000))) as {
      handle: string;
    };
    expect(broker.takeAsset(asset.handle).bytes).toEqual(bytes);
    expect(browser).not.toHaveBeenCalled();
  } finally {
    broker.dispose();
  }
});

it('retains SDK origin checks and routes only granted text requests through always mode', async () => {
  const current = scope('always');
  const browser = vi.spyOn(sourceWebViewHost, 'request').mockResolvedValue({
    statusCode: 200,
    bytes: Buffer.from('decoded text'),
    url,
    contentType: 'text/plain',
    headers: { 'content-encoding': 'gzip', 'content-length': '100' },
  });
  const transport = vi.fn(async () => {
    throw new Error('must use browser');
  });
  const broker = createSourceBroker(
    { origins: ['https://sdk.example'] },
    {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      session: sourceBrowserSdkSession(current),
      transport,
    },
  );
  try {
    await expect(
      broker.methods['http.request']({ url: 'https://denied.example', response: 'text' }, AbortSignal.timeout(2000)),
    ).rejects.toThrow('source_url_denied');
    expect(browser).not.toHaveBeenCalled();
    expect(await broker.methods['http.request']({ url, response: 'text' }, AbortSignal.timeout(2000))).toEqual({
      text: 'decoded text',
    });
    expect(browser).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  } finally {
    broker.dispose();
  }
});
