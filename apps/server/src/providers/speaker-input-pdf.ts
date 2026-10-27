import { deflate } from 'node:zlib';
import { promisify } from 'node:util';
import { connectionError } from './tts-connection-config.js';

const compress = promisify(deflate);
const MAX_INPUT = 500_000;
const MAX_PAGES = 64;
const MAX_BYTES = 4 * 1024 * 1024;
const COLUMNS = 1180;
const ROWS = 830;
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const ascii = (s: string) => Buffer.from(s, 'ascii');

/** Dense native-text PDF, not a raster/OCR document. No fonts, browser, files or remote assets are loaded.
 * Uses standard PDF Type0/ToUnicode mapping; the user-supplied Provider Manager 1.19.1 inspired the approach.
 * Transport encoding only: semantic model revisions and stored source offsets remain unchanged.
 */
export async function speakerInputPdf(text: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!text || text.length > MAX_INPUT || text !== Buffer.from(text, 'utf8').toString('utf8'))
    throw connectionError('PDF로 보낼 입력이 너무 크거나 올바르지 않아요.', 413);
  const ids = new Map<string, number>();
  const pages: string[][] = [[]];
  const push = (line: string) => {
    if (pages.at(-1)!.length === ROWS) pages.push([]);
    if (pages.length > MAX_PAGES) throw connectionError('PDF가 너무 길어요. 입력 범위를 줄여 주세요.', 413);
    pages.at(-1)!.push(line);
  };
  // Wrap by Unicode code point; surrogate pairs are never split or normalized.
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let encoded = '';
    let column = 0;
    for (const char of line) {
      let id = ids.get(char);
      if (id === undefined) {
        if (ids.size === 65535) throw connectionError('PDF의 서로 다른 문자 수가 한도를 넘었어요.', 413);
        id = ids.size + 1;
        ids.set(char, id);
      }
      encoded += hex(id);
      if (++column === COLUMNS) {
        push(encoded);
        encoded = '';
        column = 0;
      }
    }
    if (column || !line) push(encoded);
  }
  const mappings = [...ids].map(([char, id]) => {
    let unicode = '';
    for (let i = 0; i < char.length; i++) unicode += hex(char.charCodeAt(i));
    return `<${hex(id)}> <${unicode}>`;
  });
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /BOAAUnicode def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < mappings.length; i += 100) {
    const group = mappings.slice(i, i + 100);
    cmap.push(`${group.length} beginbfchar`, ...group, 'endbfchar');
  }
  cmap.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  const stream = async (text: string) => {
    signal.throwIfAborted();
    const bytes = await compress(ascii(text));
    signal.throwIfAborted();
    return Buffer.concat([
      ascii(`<< /Length ${bytes.length} /Filter /FlateDecode >>\nstream\n`),
      bytes,
      ascii('\nendstream'),
    ]);
  };
  const objects: Buffer[] = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${7 + i * 2} 0 R`).join(' ')}] >>`),
    ascii(
      '<< /Type /Font /Subtype /Type0 /BaseFont /BOAAUnicode /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>',
    ),
    ascii(
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BOAAUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 500 /CIDToGIDMap /Identity >>',
    ),
    ascii(
      '<< /Type /FontDescriptor /FontName /BOAAUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 500 >>',
    ),
    await stream(cmap.join('\n')),
  ];
  let size = objects.reduce((sum, obj) => sum + obj.length, 0);
  for (const [i, lines] of pages.entries()) {
    signal.throwIfAborted();
    const page = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F0 3 0 R >> >> /Contents ${8 + i * 2} 0 R >>`,
    );
    const content = await stream(
      ['BT', '/F0 1 Tf', '1 TL', '1 0 0 1 2 839 Tm', ...lines.flatMap((line) => [`<${line}> Tj`, 'T*']), 'ET'].join(
        '\n',
      ),
    );
    objects.push(page, content);
    size += page.length + content.length;
    if (size > MAX_BYTES) throw connectionError('PDF 입력 용량이 한도를 넘었어요.', 413);
  }
  const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let offset = chunks[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(offset);
    const bytes = Buffer.concat([ascii(`${i + 1} 0 obj\n`), object, ascii('\nendobj\n')]);
    chunks.push(bytes);
    offset += bytes.length;
  }
  chunks.push(
    ascii(
      [
        `xref\n0 ${offsets.length}`,
        '0000000000 65535 f ',
        ...offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n `),
        `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
      ].join('\n'),
    ),
  );
  const pdf = Buffer.concat(chunks);
  if (pdf.length > MAX_BYTES) throw connectionError('PDF 입력 용량이 한도를 넘었어요.', 413);
  signal.throwIfAborted();
  return pdf;
}
