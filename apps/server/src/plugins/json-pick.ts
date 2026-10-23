import { pluginJsonPick } from '../../../../packages/extension-contracts/plugin-http';

/** Field selection only: no script, filter, sorting, renaming or synthetic pagination. */
export function pickPluginJson(input: unknown, paths: string[][]): unknown {
  if (!pluginJsonPick(paths)) throw Error('HTTP_JSON_PICK_INVALID');
  let visited = 0;
  const visit = (value: unknown, selectors: string[][]): unknown => {
    if (++visited > 8192) throw Error('HTTP_JSON_PICK_LIMIT');
    if (value === null) return value;
    const terminal = selectors.some((path) => path.length === 0);
    if (Array.isArray(value)) {
      // Array indices are deliberately unsupported: selection never changes position or length.
      if (value.length > 256 || (!terminal && selectors.some((path) => path[0] !== '*')))
        throw Error('HTTP_JSON_PICK_ARRAY');
      return value.map((item) =>
        visit(
          item,
          selectors.map((path) => path.slice(1)),
        ),
      );
    }
    if (typeof value !== 'object') {
      if (terminal) return value;
      throw Error('HTTP_JSON_PICK_TYPE');
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      const matching = terminal ? [['*']] : selectors.filter((path) => path[0] === '*' || path[0] === key);
      if (!matching.length) continue;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('HTTP_JSON_PICK_KEY');
      result[key] = visit(
        (value as Record<string, unknown>)[key],
        matching.map((path) => path.slice(1)),
      );
    }
    return result;
  };
  return visit(input, paths);
}
