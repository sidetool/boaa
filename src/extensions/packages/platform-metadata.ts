import { isUiJson } from '@boaa/extension-contracts/ui-json';
/** Duplicate-aware bounded JSON parse. Native JSON.parse alone silently accepts duplicate keys. */
export function parsePlatformMetadata(text: string): unknown {
  if (new TextEncoder().encode(text).length > 16384) throw Error('INVALID_HEADER');
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw Error('INVALID_HEADER');
  };
  const parse = (depth: number): unknown => {
    if (depth > 20) throw Error('INVALID_HEADER');
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{',
        close = object ? '}' : ']';
      const result: Record<string, unknown> = Object.create(null),
        array: unknown[] = [];
      space();
      if (text[i] === close) {
        i++;
        return object ? result : array;
      }
      while (i < text.length) {
        if (object) {
          space();
          if (text[i] !== '"') throw Error('INVALID_HEADER');
          const key = string();
          if (Object.prototype.hasOwnProperty.call(result, key)) throw Error('DUPLICATE_KEY');
          space();
          if (text[i++] !== ':') throw Error('INVALID_HEADER');
          result[key] = parse(depth + 1);
        } else array.push(parse(depth + 1));
        space();
        if (text[i] === close) {
          i++;
          return object ? result : array;
        }
        if (text[i++] !== ',') throw Error('INVALID_HEADER');
      }
      throw Error('INVALID_HEADER');
    }
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    return JSON.parse(text.slice(start, i));
  };
  // Native parser enforces JSON whitespace/escape/number grammar; own traversal checks duplicates.
  JSON.parse(text);
  const result = parse(0);
  space();
  if (i !== text.length || !isUiJson(result, 16384)) throw Error('INVALID_HEADER');
  return result;
}
