import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readDavResponses, type DavResponse } from './webdav-xml.js';
const wrap = (inner: string) => `<d:multistatus xmlns:d="DAV:">${inner}</d:multistatus>`;
const item =
  '<d:response><d:href>/책/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>&quot;v1&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
async function parse(xml: string, bytes = 100_000, count = 10) {
  const buffer = Buffer.from(xml);
  const stream = Readable.from([...buffer].map((n) => Buffer.from([n]))) as IncomingMessage;
  const rows: DavResponse[] = [];
  await readDavResponses(stream, bytes, count, (row) => rows.push(row));
  return rows;
}
it('streams UTF8 and namespace-qualified DAV properties across byte boundaries', async () => {
  expect(await parse(wrap(item))).toEqual([{ href: '/책/', properties: { directory: true, etag: '"v1"' } }]);
});
it.each([
  '<!DOCTYPE x [<!ENTITY external SYSTEM "file:///secret">]>' + wrap(item),
  wrap(item).replace('</d:multistatus>', ''),
  wrap(item).replace('xmlns:d="DAV:"', 'xmlns:d="other"'),
  wrap(item).replace('&quot;v1&quot;', '&unknown;'),
])('rejects invalid XML, DTDs and wrong namespaces', async (xml) => {
  await expect(parse(xml)).rejects.toThrow('invalid_response');
});
it('bounds wire bytes, response count, nesting and individual property text', async () => {
  await expect(parse(wrap(item), 40)).rejects.toThrow('listing_limit');
  await expect(parse(wrap(item + item), 100_000, 1)).rejects.toThrow('listing_limit');
  await expect(parse(wrap('<x>'.repeat(33) + '</x>'.repeat(33)))).rejects.toThrow('listing_limit');
  await expect(parse(wrap(item.replace('/책/', 'x'.repeat(8193))))).rejects.toThrow('listing_limit');
});
it('ignores unsuccessful property groups and reads the successful group', async () => {
  const xml = wrap(
    item.replace(
      '<d:propstat>',
      '<d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat><d:propstat>',
    ),
  );
  expect((await parse(xml))[0].properties?.directory).toBe(true);
});
