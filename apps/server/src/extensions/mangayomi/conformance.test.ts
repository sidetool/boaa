import { createCipheriv } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invokeMangayomi } from './runtime.js';
import { MangayomiExtensionHost } from './host.js';
import { EncryptedSourceCredentialVault } from '../source-credential-vault.js';
import { parseMangayomiIndex } from '../../../../../packages/extension-contracts/compatibility-repository.js';
import { fixtureRow } from './test-fixture.js';
import { imageSource, novelSource, orderedPagesSource } from './fixtures/synthetic-sources.js';
import type { compatibilityHttp } from './http.js';

const entry = parseMangayomiIndex([fixtureRow])[0];
const signal = () => AbortSignal.timeout(10000);
const response = (url: string, body: string) => ({
  url,
  bytes: Buffer.from(body),
  headers: {},
  contentType: 'text/html; charset=utf-8',
  statusCode: 200,
});

describe('synthetic Mangayomi JS contract', () => {
  it('matches string delimiters, DOM empty nodes and preference defaults inside the isolated realm', async () => {
    const output = await invokeMangayomi({
      entry,
      signal: signal(),
      action: 'detail',
      source: `class DefaultExtension extends MProvider {
        getDetail(){
          const d=new Document('<section class="a b"><a href="/work" data-empty=""><b>A</b>  B</a><img data-src="/lazy.png" src="/image.png"></section>');
          const a=d.selectFirst('a');const missing=d.selectFirst('.missing');const prefs=new SharedPreferences();
          return {
            strings:['a:b:c'.substringAfter(':'),'a:b:c'.substringAfterLast(':'),'a:b:c'.substringBefore(':'),'a:b:c'.substringBeforeLast(':'),'a:b:c'.substringBetween(':',':'),'abc'.substringBetween('[',']'),'[abc'.substringBetween('[',']'),'abc'.substringAfter('!'),'abc'.substringBefore('!'),'abc'.substringAfterLast(''),'abc'.substringBeforeLast('')],
            dom:{html:a.innerHtml,alias:a.html,text:a.text,href:a.getHref,descendant:d.selectFirst('section').getHref,src:d.selectFirst('img').getSrc,lazy:d.selectFirst('img').getDataSrc,empty:a.hasAttr('data-empty'),absent:a.hasAttr('missing'),classes:d.getElementsByClassName('b a').length,missing:[missing.text,missing.innerHtml,missing.attr('href'),missing.select('a').length,missing.selectFirst('a').text,missing.nextElementSibling.text]},
            preferences:[prefs.getString('missing','default'),prefs.getString('missing','other'),prefs.getString('empty','default')]
          };
        }
      }`,
      preferences: { empty: '' },
    });
    expect(output.result).toEqual({
      strings: ['b:c', 'c', 'a', 'a:b', 'b', '', '', 'abc', 'abc', 'c', 'abc'],
      dom: {
        html: '<b>A</b>  B',
        alias: '<b>A</b>  B',
        text: 'A  B',
        href: '/work',
        descendant: '/work',
        src: '/lazy.png',
        lazy: '/lazy.png',
        empty: true,
        absent: false,
        classes: 1,
        missing: ['', '', '', 0, '', ''],
      },
      preferences: ['default', 'default', ''],
    });
    expect(output.changes).toEqual({ missing: 'default' });
  });

  it('accepts only the optional not-implemented signal and still rejects real source errors', async () => {
    for (const method of ['getSourcePreferences', 'getHeaders']) {
      const source = `class DefaultExtension extends MProvider {
        ${method}(){throw new Error('${method} not implemented');}
        async getPageList(){return ['https://site.example/page.png'];}
      }`;
      expect((await invokeMangayomi({ entry, source, action: 'pages', signal: signal() })).result).toEqual([
        { url: 'https://site.example/page.png', headers: {} },
      ]);
      await expect(
        invokeMangayomi({
          entry,
          source: source.replace(`${method} not implemented`, 'actual source failure'),
          action: 'pages',
          signal: signal(),
        }),
      ).rejects.toThrow();
    }
  });

  it('matches synchronous AES-CBC page response decoding', async () => {
    const iv = '0123456789abcdef';
    const key = 'fixture-aes-key!';
    const plain = JSON.stringify([{ url: 'https://img.example/1.png' }, { url: 'https://img.example/2.png' }]);
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex');
    const source = `class DefaultExtension extends MProvider {
      base64encode(str) {
        const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let out='',i=0;
        while(i<str.length){const a=str.charCodeAt(i++)&255;if(i===str.length){out+=chars[a>>2]+chars[(a&3)<<4]+'==';break;}
          const b=str.charCodeAt(i++)&255;if(i===str.length){out+=chars[a>>2]+chars[((a&3)<<4)|(b>>4)]+chars[(b&15)<<2]+'=';break;}
          const c=str.charCodeAt(i++)&255;out+=chars[a>>2]+chars[((a&3)<<4)|(b>>4)]+chars[((b&15)<<2)|(c>>6)]+chars[c&63];}
        return out;
      }
      decode(value){const iv=value.substring(0,16);const hex=value.substring(16);const bytes=[];for(let i=0;i<hex.length;i+=2)bytes.push(parseInt(hex.substr(i,2),16));return cryptoHandler(this.base64encode(String.fromCharCode.apply(null,bytes)),iv,'${key}',false);}
      async getPageList(){const response=await new Client().get('https://catalog.example/chapter');const value=response.body.match(/contentKey="(.*)"/)[1];return JSON.parse(this.decode(value)).map(page=>page.url);}
    }`;
    const output = await invokeMangayomi(
      { entry: { ...entry, baseUrl: 'https://catalog.example' }, source, action: 'pages', signal: signal() },
      async ({ url }) => response(url, `<script contentKey="${iv}${encrypted}"></script>`),
    );
    expect(output.result).toEqual([
      { url: 'https://img.example/1.png', headers: {} },
      { url: 'https://img.example/2.png', headers: {} },
    ]);
  });

  it('extracts lists and ordered pages from deterministic HTML', async () => {
    const calls: string[] = [];
    const transport: typeof compatibilityHttp = async ({ url }) => {
      calls.push(url);
      if (url.endsWith('/works'))
        return response(
          url,
          '<a class="work" href="works/example"><span>Example</span><img src="https://img.example/cover.png"></a><a class="next"></a>',
        );
      expect(url).toBe('https://catalog.example/works/example/chapter-1');
      return response(
        url,
        '<script>payload=' +
          JSON.stringify({
            pages: [
              { order: 2, url: 'https://img.example/2.png' },
              { order: 1, url: 'https://img.example/1.png' },
            ],
          }) +
          ';</script>',
      );
    };
    const syntheticEntry = { ...entry, baseUrl: 'https://catalog.example' };
    const listing = await invokeMangayomi(
      { entry: syntheticEntry, source: orderedPagesSource, action: 'list', signal: signal() },
      transport,
    );
    expect(listing.result).toMatchObject({
      list: [{ name: 'Example', link: 'works/example', imageUrl: 'https://img.example/cover.png' }],
      hasNextPage: false,
    });
    const pages = await invokeMangayomi(
      {
        entry: syntheticEntry,
        source: orderedPagesSource,
        action: 'pages',
        params: { chapterUrl: 'works/example/chapter-1' },
        signal: signal(),
      },
      transport,
    );
    expect(pages.result).toEqual([
      { url: 'https://img.example/1.png', headers: { Referer: syntheticEntry.baseUrl } },
      { url: 'https://img.example/2.png', headers: { Referer: syntheticEntry.baseUrl } },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('installs a synthetic novel and imports already-cleaned content once after reopening', async () => {
    const source = Buffer.from(novelSource);
    const root = await mkdtemp(join(tmpdir(), 'boaa-synthetic-novel-'));
    let host: MangayomiExtensionHost | undefined;
    const calls: string[] = [];
    const transport: typeof compatibilityHttp = async ({ url, method }) => {
      calls.push(`${method ?? 'GET'} ${url}`);
      if (url.endsWith('/works'))
        return response(
          url,
          JSON.stringify({ list: [{ name: 'Example novel', link: '/works/work' }], hasNextPage: false }),
        );
      if (url.endsWith('/works/work/chapters')) {
        expect(method).toBe('POST');
        return response(url, '<a class="chapter" href="https://catalog.example/chapter/1">Chapter 1</a>');
      }
      expect(url).toBe('https://catalog.example/chapter/1');
      return response(
        url,
        '<h1>Chapter 1</h1><article><p>First &amp; second</p><p>마지막 문장</p></article><aside>Never import this</aside>',
      );
    };
    const vault = new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 7));
    try {
      host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
      const plan = await host.inspectFile(source, 'synthetic-novel.js', 0, signal());
      await host.install(plan.id, plan.revision, signal());
      const id = host.catalog.getSources()[0].descriptor.id;
      host.close();
      host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
      expect(host.catalog.getSources()[0].descriptor.id).toBe(id);
      const works = await host.catalog.invoke(id, 'source.listWorks', {}, signal());
      const workId = works.result.items[0].id;
      expect(works.result.items[0].title).toBe('Example novel');
      const releases = await host.catalog.invoke(id, 'source.listReleases', { workId }, signal());
      const result = await host.catalog.invoke(
        id,
        'source.getContent',
        { workId, releaseId: releases.result.items[0].id },
        signal(),
      );
      expect(result.result.kind).toBe('text');
      if (result.result.kind !== 'text') throw new Error('Expected text');
      const text = await result.assets.get(result.result.asset.handle)?.text();
      expect(text).toContain('Chapter 1');
      expect(text).toContain('First & second');
      expect(text).toContain('마지막 문장');
      expect(text).not.toMatch(/undefined|Never import this|<article>/);
      expect(calls.filter((call) => call.includes('/chapter/1'))).toHaveLength(1);
    } finally {
      host?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('saves synthetic image-source language preferences and reopens content without losing catalog titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boaa-synthetic-images-'));
  const urls: string[] = [];
  const transport: typeof compatibilityHttp = async ({ url }) => {
    urls.push(url);
    if (url.endsWith('/page.png'))
      return {
        ...response(url, ''),
        bytes: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOm0AAAAASUVORK5CYII=',
          'base64',
        ),
        contentType: 'image/png',
      };
    if (url.includes('/chapters/chapter/pages'))
      return response(url, JSON.stringify({ pages: ['https://images.example/page.png'] }));
    if (url.includes('/works/work'))
      return response(
        url,
        JSON.stringify({ description: 'Fixture', chapters: [{ name: 'Chapter 1', url: '/chapters/chapter/pages' }] }),
      );
    return response(url, JSON.stringify({ list: [{ name: 'Fixture work', link: '/works/work' }], hasNextPage: false }));
  };
  const vault = new EncryptedSourceCredentialVault(join(root, 'vault'), Buffer.alloc(32, 8));
  let host: MangayomiExtensionHost | undefined;
  try {
    host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
    const review = await host.inspectFile(Buffer.from(imageSource), 'synthetic-images.js', 1, signal());
    await host.install(review.id, review.revision, signal());
    expect(review.fileSources).toEqual([
      { name: 'Synthetic images', lang: 'ko' },
      { name: 'Synthetic images', lang: 'en' },
    ]);
    const pkg = host.snapshot().packages[0].pkg;
    const sourceId = host.catalog.getSources()[0].descriptor.id;
    const defaults = host.preferences(pkg);
    expect(defaults.fields.find((f) => f.key === 'language')).toMatchObject({ kind: 'select', value: 'en' });
    expect(defaults.fields.find((f) => f.key === 'original_languages')).toMatchObject({
      kind: 'multi-select',
      value: [],
    });
    await host.catalog.invoke(sourceId, 'source.listWorks', {}, signal());
    expect(urls.at(-1)).not.toContain('originalLanguage');
    await expect(
      host.savePreferences(pkg, defaults.revision, { original_languages: ['not-a-choice'] }, []),
    ).rejects.toThrow('compatibility_preferences_invalid');
    await host.savePreferences(
      pkg,
      defaults.revision,
      { original_languages: ['originalLanguage[]=ko', 'originalLanguage[]=ja'] },
      [],
    );
    host.close();
    host = await MangayomiExtensionHost.open(join(root, 'host'), vault, transport);
    expect(host.preferences(pkg).fields.find((f) => f.key === 'original_languages')?.value).toEqual([
      'originalLanguage[]=ko',
      'originalLanguage[]=ja',
    ]);
    const result = await host.catalog.invoke(sourceId, 'source.listWorks', {}, signal());
    expect(result.result.items[0].title).toBe('Fixture work');
    expect(urls.at(-1)).toContain('&originalLanguage[]=ko&originalLanguage[]=ja');
    const workId = result.result.items[0].id;
    const detail = await host.catalog.invoke(sourceId, 'source.getWork', { workId }, signal());
    expect(detail.result).toMatchObject({ id: workId, title: 'Fixture work', description: 'Fixture' });
    const releases = await host.catalog.invoke(sourceId, 'source.listReleases', { workId }, signal());
    expect(releases.result.items).toHaveLength(1);
    const content = await host.catalog.invoke(
      sourceId,
      'source.getContent',
      { workId, releaseId: releases.result.items[0].id },
      signal(),
    );
    expect(content.result.kind).toBe('images');
    expect(content.assets.size).toBe(1);
    const asset = [...content.assets.values()][0];
    expect(asset.type).toBe('image/png');
    expect(asset.size).toBeGreaterThan(0);
    await host.savePreferences(pkg, host.preferences(pkg).revision, { original_languages: [] }, []);
    await host.catalog.invoke(sourceId, 'source.listWorks', {}, signal());
    expect(urls.at(-1)).not.toContain('originalLanguage');
  } finally {
    host?.close();
    await rm(root, { recursive: true, force: true });
  }
});
