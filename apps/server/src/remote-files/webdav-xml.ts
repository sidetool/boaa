import { SaxesParser } from 'saxes';
import type { IncomingMessage } from 'node:http';
import { failure } from './common.js';
export interface DavResponse {
  href: string;
  properties?: { directory: boolean; size?: string; modified?: string; etag?: string };
}
/** Parse each DAV response as it arrives; never construct a DOM for the whole directory. */
export async function readDavResponses(
  response: IncomingMessage,
  maxBytes: number,
  maxEntries: number,
  accept: (row: DavResponse) => void,
) {
  const parser = new SaxesParser({ xmlns: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tags: string[] = [];
  let row: DavResponse | undefined;
  let props: NonNullable<DavResponse['properties']> | undefined;
  let status = '',
    count = 0,
    nodes = 0,
    bytes = 0,
    propPresent = false;
  const invalid = () => {
    throw failure('invalid_response');
  };
  const append = (before: string | undefined, text: string) => {
    const value = (before ?? '') + text;
    if (value.length > 8192) throw failure('listing_limit');
    return value;
  };
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && !/^utf-?8$/i.test(declaration.encoding)) invalid();
  });
  parser.on('opentag', (tag) => {
    tags.push(tag.uri === 'DAV:' ? tag.local : '');
    if (++nodes > 2_000_000 || tags.length > 32) throw failure('listing_limit');
    const depth = tags.length;
    if (depth === 1 && tags[0] !== 'multistatus') invalid();
    if (depth === 2 && tags[1] === 'response') {
      if (++count > maxEntries) throw failure('listing_limit');
      row = { href: '' };
    }
    if (row && depth === 3 && tags[2] === 'propstat') {
      props = { directory: false };
      status = '';
      propPresent = false;
    }
    if (props && depth === 4 && tags[3] === 'prop') propPresent = true;
    if (props && depth === 6 && tags[3] === 'prop' && tags[4] === 'resourcetype' && tags[5] === 'collection')
      props.directory = true;
  });
  const text = (value: string) => {
    if (!row) return;
    if (tags.length === 3 && tags[2] === 'href') row.href = append(row.href, value);
    if (!props || tags[2] !== 'propstat') return;
    if (tags.length === 4 && tags[3] === 'status') status = append(status, value);
    if (tags.length !== 5 || tags[3] !== 'prop') return;
    if (tags[4] === 'getcontentlength') props.size = append(props.size, value);
    if (tags[4] === 'getlastmodified') props.modified = append(props.modified, value);
    if (tags[4] === 'getetag') props.etag = append(props.etag, value);
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    if (row && tags.length === 3 && tags[2] === 'propstat') {
      if (/\s200(?:\s|$)/.test(status)) {
        if (!propPresent) invalid();
        if (!row.properties) row.properties = props;
      }
      props = undefined;
    }
    if (row && tags.length === 2 && tags[1] === 'response') {
      accept(row);
      row = undefined;
    }
    tags.pop();
  });
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw failure('listing_limit');
      parser.write(decoder.decode(chunk, { stream: true }));
    }
    parser.write(decoder.decode()).close();
  } catch (error) {
    response.destroy();
    if (error instanceof Error && error.message.startsWith('remote_files_')) throw error;
    throw failure('invalid_response');
  }
}
