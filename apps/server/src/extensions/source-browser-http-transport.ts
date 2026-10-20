import { randomUUID } from 'node:crypto';
import type { Page, Response } from 'playwright-core';
import type { CompatibilityHttpInput } from './mangayomi/http.js';
import { compatibilityHttpPolicy } from './mangayomi/http-options.js';

/** Use actual browser networking without allowing navigation to follow redirects outside host policy. */
export async function requestInSourceBrowser(
  page: Page,
  input: CompatibilityHttpInput,
  maximum: number,
  followRedirects: boolean,
  permitted: (url: string) => URL,
) {
  let url = permitted(input.url);
  let method = input.method ?? 'GET';
  let body = input.body;
  let remaining = maximum;
  const initialOrigin = url.origin;
  const bootstrap = new Set<string>();
  await page.route('**/*', async (route) => {
    if (bootstrap.has(route.request().url()))
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Source transport</title>',
      });
    else await route.fallback();
  });
  const { maxRedirects } = compatibilityHttpPolicy(input.options);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const inert = new URL('/.boaa-source-' + randomUUID(), url.origin).href;
    bootstrap.add(inert);
    await page.goto(inert, { waitUntil: 'domcontentloaded', timeout: 0 });
    let observed: Response | undefined;
    const receive = (response: Response) => {
      if (response.url() === url.href && response.request().resourceType() === 'fetch') observed = response;
    };
    page.on('response', receive);
    const read = async ({
      target,
      method,
      body,
      headers,
      maximum,
    }: {
      target: string;
      method: string;
      body?: string;
      headers: Record<string, string>;
      maximum: number;
    }) => {
      const abort = new AbortController();
      try {
        const response = await fetch(target, {
          method,
          body,
          headers,
          redirect: 'manual',
          credentials: 'include',
          cache: 'no-store',
          signal: abort.signal,
        });
        const chunks: string[] = [];
        let length = 0;
        if (method !== 'HEAD' && Number(response.headers.get('content-length')) > maximum)
          return { error: 'source_body_limit' };
        const reader = response.body?.getReader();
        if (reader)
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > maximum) return { error: 'source_body_limit' };
            for (let start = 0; start < value.length; start += 32768)
              chunks.push(btoa(String.fromCharCode(...value.subarray(start, start + 32768))));
          }
        return { chunks, length };
      } finally {
        abort.abort();
      }
    };
    let payload: { error?: string; chunks?: string[]; length?: number };
    try {
      const headers = Object.fromEntries(
        Object.entries(url.origin === initialOrigin ? (input.headers ?? {}) : {}).filter(
          ([name]) => !['user-agent', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
        ),
      );
      // Main-world execution is required for Firefox's streamed Uint8Array values.
      payload = await page.evaluate(
        'mw:(' +
          read.toString() +
          ')(' +
          JSON.stringify({
            target: url.href,
            method,
            body,
            headers,
            maximum: remaining,
          }) +
          ')',
      );
    } finally {
      page.off('response', receive);
    }
    if (payload.error) throw new Error(payload.error);
    if (!observed) throw new Error('source_http_failed');
    const response = observed as Response;
    const headers: Record<string, string | string[]> = await response.allHeaders();
    const cookies = (await response.headersArray()).filter((row) => row.name.toLowerCase() === 'set-cookie');
    if (cookies.length) headers['set-cookie'] = cookies.map((row) => row.value);
    const bytes = Buffer.concat(
      (payload.chunks ?? []).map((chunk) => Buffer.from(chunk, 'base64')),
      payload.length,
    );
    const statusCode = response.status();
    if (!followRedirects || ![301, 302, 303, 307, 308].includes(statusCode))
      return { statusCode, headers, bytes, contentType: response.headers()['content-type'] ?? '', url: url.href };
    const location = response.headers().location;
    if (hop === maxRedirects || !location) throw new Error('source_redirect_limit');
    const next = permitted(new URL(location, url).href);
    if (next.origin !== url.origin && !['GET', 'HEAD'].includes(method)) throw new Error('source_redirect_denied');
    if (statusCode === 303 || ([301, 302].includes(statusCode) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    remaining -= bytes.length;
    if (remaining <= 0) throw new Error('source_body_limit');
    url = next;
  }
  throw new Error('source_redirect_limit');
}
