import { expect, it } from 'vitest';
import { pluginHttpRequest, pluginJsonPick } from '../../../../packages/extension-contracts/plugin-http';
import { pickPluginJson } from './json-pick';
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

it('unions object wildcard and explicit paths while preserving every array position and null', () => {
  const input = {
    rows: [{ id: 1, tag: 'a', ignored: 1 }, null, { tag: 'b' }],
    map: { '12': { id: 12, title: 'one' }, '20': { id: 20, title: 'two' } },
    ignored: true,
  };
  expect(
    plain(
      pickPluginJson(input, [
        ['rows', '*', 'id'],
        ['rows', '*', 'tag'],
        ['map', '*', 'id'],
        ['map', '12', 'title'],
      ]),
    ),
  ).toEqual({
    rows: [{ id: 1, tag: 'a' }, null, { tag: 'b' }],
    map: { '12': { id: 12, title: 'one' }, '20': { id: 20 } },
  });
  expect(input.rows[0]).toEqual({ id: 1, tag: 'a', ignored: 1 });
});
it('retains empties and null but rejects traversal through scalar values and numeric array indices', () => {
  expect(
    plain(
      pickPluginJson({ rows: [], empty: {}, nil: null }, [
        ['rows', '*', 'id'],
        ['empty', 'missing'],
        ['nil', 'missing'],
      ]),
    ),
  ).toEqual({ rows: [], empty: {}, nil: null });
  expect(() => pickPluginJson({ rows: [1] }, [['rows', '*', 'id']])).toThrow('HTTP_JSON_PICK_TYPE');
  expect(() => pickPluginJson({ rows: [{ id: 1 }] }, [['rows', '0', 'id']])).toThrow('HTTP_JSON_PICK_ARRAY');
  expect(plain(pickPluginJson({ '0': { id: 1 } }, [['0', 'id']]))).toEqual({ '0': { id: 1 } });
});
it('enforces path syntax/count/depth/segment bounds and JSON-only request selection', () => {
  expect(pluginJsonPick(Array.from({ length: 48 }, () => Array(8).fill('x'.repeat(64))))).toBe(true);
  for (const paths of [
    [],
    [[]],
    Array.from({ length: 49 }, () => ['x']),
    [Array(9).fill('x')],
    [['x'.repeat(65)]],
    [['']],
    [['a.b']],
    [['한글']],
    [['__proto__']],
    [['prototype']],
    [['constructor']],
  ])
    expect(pluginJsonPick(paths)).toBe(false);
  const input = { slot: 'api', path: 'list', method: 'GET', response: 'json', pick: [['rows', '*', 'id']] };
  expect(pluginHttpRequest(input)).toBe(true);
  expect(pluginHttpRequest({ ...input, response: 'text' })).toBe(false);
  expect(pluginHttpRequest({ ...input, pick: [] })).toBe(false);
});
it('rejects dangerous wildcard keys without polluting objects and enforces traversal bounds', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const input = JSON.parse(`{"rows":{"${key}":{"id":1}}}`);
    expect(() => pickPluginJson(input, [['rows', '*', 'id']])).toThrow('HTTP_JSON_PICK_KEY');
  }
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  expect(() => pickPluginJson({ rows: Array.from({ length: 257 }, () => ({ id: 1 })) }, [['rows', '*', 'id']])).toThrow(
    'HTTP_JSON_PICK_ARRAY',
  );
  const many = Object.fromEntries(Array.from({ length: 8192 }, (_, i) => ['k' + i, { id: i }]));
  expect(() => pickPluginJson({ map: many }, [['map', '*', 'id']])).toThrow('HTTP_JSON_PICK_LIMIT');
});
it('applies the array item bound to retained terminal subtrees as well as mapped arrays', () => {
  const input = { rows: Array.from({ length: 257 }, () => 1) };
  expect(() => pickPluginJson(input, [['rows']])).toThrow();
});
