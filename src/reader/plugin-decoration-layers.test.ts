import { describe, expect, it, vi } from 'vitest';
import { ReaderDecorationStore } from '../features/reader/reader-decoration-store';
import { ReaderPluginDecorationLayers } from './plugin-decoration-layers';
import { composePluginText } from './plugin-text-composition';
import { decorateReaderText } from './text-decorations';
const output = (start = 0, end = 2, style: unknown = { color: '#123456' }) => ({
  layers: [{ id: 'paint', palette: { ink: style }, ranges: [{ paragraphId: 'p', start, end, styleId: 'ink' }] }],
});
const blocks = [{ id: 'p', text: 'abcdef' }];
describe('plugin-owned Reader layers', () => {
  it('invalidates jobs on replacement/reset and rejects copied or reused leases', () => {
    const store = new ReaderPluginDecorationLayers(() => {});
    const old = store.prepare('a', 0, blocks),
      current = store.prepare('a', 0, blocks);
    expect(() => store.replace(old, output())).toThrow('STALE');
    expect(() => store.replace({ ...current }, output())).toThrow('STALE');
    store.replace(current, output());
    expect(() => store.replace(current, output())).toThrow('STALE');
    const pending = store.prepare('b', 0, blocks);
    store.reset();
    expect(() => store.replace(pending, output())).toThrow('STALE');
    expect(store.getSnapshot('p')).toEqual([]);
  });
  it.each([
    output(-1),
    output(0, 10),
    output(0, 1.5),
    output(2, 2),
    output(0, 2, { color: 'url(https://evil)' }),
    output(0, 2, { fontSize: 90 }),
    {
      layers: [
        {
          id: 'paint',
          palette: { ink: { color: '#ffffff' } },
          ranges: [{ paragraphId: 'other', start: 0, end: 1, styleId: 'ink' }],
        },
      ],
    },
  ])('rejects malformed or out-of-scope output without keeping old paint', (value) => {
    const store = new ReaderPluginDecorationLayers(() => {});
    store.replace(store.prepare('a', 0, blocks), output());
    expect(() => store.replace(store.prepare('a', 0, blocks), value)).toThrow();
    expect(store.getSnapshot('p')).toEqual([]);
  });
  it.each(['😀', 'e\u0301', '👨‍👩‍👧'])('never splits a grapheme %s', (text) => {
    const store = new ReaderPluginDecorationLayers(() => {});
    expect(() => store.replace(store.prepare('a', 0, [{ id: 'p', text }]), output(0, 1))).toThrow();
    store.replace(store.prepare('a', 0, [{ id: 'p', text }]), output(0, text.length));
    expect(store.getSnapshot('p')).toHaveLength(1);
  });
  it('merges properties in stable owner order and preserves native emphasis', () => {
    const store = new ReaderPluginDecorationLayers(() => {});
    store.replace(store.prepare('z', 1, blocks), output(0, 2, { color: '#abcdef', underline: true }));
    store.replace(store.prepare('a', 0, blocks), output(0, 2, { color: '#123456', backgroundColor: '#ffffff' }));
    const layers = store.getSnapshot('p');
    expect(composePluginText('abcdef', decorateReaderText('abcdef', [], ''), layers)[0].pluginStyle).toEqual({
      color: '#abcdef',
      backgroundColor: '#ffffff',
      underline: true,
    });
    for (const segments of [
      decorateReaderText('abcdef', [], 'ab'),
      decorateReaderText('abcdef', [{ quote: 'ab', color: 'blue' }], ''),
      decorateReaderText('abcdef', [], '', [{ start: 0, end: 2 }]),
    ])
      expect(composePluginText('abcdef', segments, layers)[0].pluginStyle).toEqual({ underline: true });
    store.remove('z');
    expect(store.getSnapshot('p')).toHaveLength(1);
  });
  it('projects canonical offsets into a page fragment and skips changed source text', () => {
    const store = new ReaderPluginDecorationLayers(() => {});
    store.replace(store.prepare('a', 0, blocks), output(1, 5));
    expect(
      composePluginText('abcdef', decorateReaderText('abcdef', [], ''), store.getSnapshot('p'), -1).some(
        (p) => p.pluginStyle,
      ),
    ).toBe(false);
    const parts = composePluginText('cdef', decorateReaderText('cdef', [], ''), store.getSnapshot('p'), 2);
    expect(parts.map((p) => [p.text, !!p.pluginStyle])).toEqual([
      ['cde', true],
      ['f', false],
    ]);
    expect(
      composePluginText('changed', decorateReaderText('changed', [], ''), store.getSnapshot('p')).some(
        (p) => p.pluginStyle,
      ),
    ).toBe(false);
  });
  it('notifies only affected Reader rows and keeps native snapshots after removal', () => {
    const store = new ReaderDecorationStore();
    const notify = vi.fn(),
      other = vi.fn();
    store.subscribe('p', notify);
    store.subscribe('other', other);
    const before = store.getSnapshot('p');
    store.plugins.replace(store.plugins.prepare('a', 0, blocks), output());
    expect(notify).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    expect(store.getSnapshot('p')).toBe(store.getSnapshot('p'));
    store.plugins.remove('a');
    expect(store.getSnapshot('p')).toBe(before);
  });
});
it('rejects excessive owners, blocks, JSON size and combined paragraph ranges', () => {
  const store = new ReaderPluginDecorationLayers(() => {});
  expect(() =>
    store.prepare(
      'a',
      0,
      Array.from({ length: 65 }, (_, i) => ({ id: String(i), text: 'a' })),
    ),
  ).toThrow();
  expect(() => store.prepare('a', 0, [{ id: 'p', text: 'a'.repeat(65536) }])).toThrow();
  const many = (count: number) => ({
    layers: [
      {
        id: 'paint',
        palette: { ink: { color: '#123456' } },
        ranges: Array.from({ length: count }, () => ({ paragraphId: 'p', start: 0, end: 1, styleId: 'ink' })),
      },
    ],
  });
  store.replace(store.prepare('a', 0, blocks), many(700));
  expect(() => store.replace(store.prepare('b', 1, blocks), many(400))).toThrow();
  expect(store.getSnapshot('p')).toHaveLength(1);
  store.reset();
  for (let i = 0; i < 16; i++) store.prepare('p' + i, i, blocks);
  expect(() => store.prepare('extra', 0, blocks)).toThrow();
});
it('validates the whole reply before publication and stores immutable detached data', () => {
  const notify = vi.fn();
  const store = new ReaderPluginDecorationLayers(notify);
  const value = output();
  value.layers.push({
    ...output().layers[0],
    id: 'z',
    ranges: [{ paragraphId: 'p', start: 0, end: 99, styleId: 'ink' }],
  });
  expect(() => store.replace(store.prepare('a', 0, blocks), value)).toThrow();
  expect(notify).not.toHaveBeenCalled();
  expect(store.getSnapshot('p')).toEqual([]);
  const valid = output();
  store.replace(store.prepare('a', 0, blocks), valid);
  valid.layers[0].ranges[0].end = 99;
  expect(store.getSnapshot('p')[0].ranges[0].end).toBe(2);
  expect(Object.isFrozen(store.getSnapshot('p'))).toBe(true);
  expect(Object.isFrozen(store.getSnapshot('p')[0].ranges)).toBe(true);
});
it('supports opaque host paragraph IDs and declines decoration without a grapheme segmenter', () => {
  const store = new ReaderPluginDecorationLayers(() => {});
  const value = output();
  value.layers[0].ranges[0].paragraphId = '문단/one';
  store.replace(store.prepare('a', 0, [{ id: '문단/one', text: 'abcdef' }]), value);
  const OriginalIntl = globalThis.Intl;
  vi.stubGlobal('Intl', {});
  try {
    expect(() => store.replace(store.prepare('a', 0, blocks), output())).toThrow();
  } finally {
    vi.stubGlobal('Intl', OriginalIntl);
    vi.unstubAllGlobals();
  }
});

it('accepts author typography and updates layout only for metric changes', () => {
  const store = new ReaderPluginDecorationLayers(() => {});
  const changed = vi.fn();
  store.subscribeLayout(changed);
  store.replace(
    store.prepare('a', 0, blocks),
    output(0, 2, { fontWeight: 700, fontStyle: 'italic', strikethrough: true }),
  );
  expect(changed).toHaveBeenCalledTimes(1);
  const revision = store.getLayoutRevision();
  store.replace(
    store.prepare('a', 0, blocks, true),
    output(0, 2, { fontWeight: 700, fontStyle: 'italic', color: '#123456' }),
  );
  expect(store.getLayoutRevision()).toBe(revision);
  store.remove('a');
  expect(changed).toHaveBeenCalledTimes(2);
});
it.each([
  { fontWeight: 0 },
  { fontWeight: 701 },
  { fontWeight: 'bold' },
  { fontStyle: 'url(x)' },
  { strikethrough: 'true' },
])('rejects invalid typography %o', (style) => {
  const store = new ReaderPluginDecorationLayers(() => {});
  expect(() => store.replace(store.prepare('a', 0, blocks), output(0, 2, style))).toThrow();
});
it('retains bounded same-context paint atomically during measurement, but clear revokes it', () => {
  const store = new ReaderPluginDecorationLayers(() => {});
  store.replace(store.prepare('a', 0, blocks), output(0, 2, { fontWeight: 700 }));
  const lease = store.prepare('a', 0, [{ id: 'q', text: 'next' }], true);
  store.replace(store.prepare('b', 1, blocks), output(2, 4, { underline: true }));
  expect(store.getSnapshot('p')[0].ranges[0].style.fontWeight).toBe(700);
  store.replace(lease, { layers: [] });
  expect(store.getSnapshot('p')[0].ranges[0].style.fontWeight).toBe(700);
  store.remove('a');
  expect(store.getSnapshot('p')).toHaveLength(1);
});
it('evicts old cached paragraphs at the display limit and rejects replies outside the new batch', () => {
  const store = new ReaderPluginDecorationLayers(() => {});
  for (let i = 0; i < 140; i++) {
    const id = `p${i}`;
    const lease = store.prepare('a', 0, [{ id, text: 'hello' }], true);
    store.replace(lease, {
      layers: [
        {
          id: 'style',
          palette: { b: { fontWeight: 700 } },
          ranges: [{ paragraphId: id, start: 0, end: 2, styleId: 'b' }],
        },
      ],
    });
  }
  expect(store.getSnapshot('p0')).toEqual([]);
  expect(store.getSnapshot('p139')).toHaveLength(1);
  const lease = store.prepare('a', 0, [{ id: 'new', text: 'hello' }], true);
  expect(() =>
    store.replace(lease, {
      layers: [
        {
          id: 'style',
          palette: { b: { fontWeight: 700 } },
          ranges: [{ paragraphId: 'p139', start: 0, end: 2, styleId: 'b' }],
        },
      ],
    }),
  ).toThrow();
});
it('does not require secure-context crypto for ordinary Reader construction', () => {
  vi.stubGlobal('crypto', undefined);
  try {
    const first = new ReaderPluginDecorationLayers(() => {}),
      second = new ReaderPluginDecorationLayers(() => {});
    expect(first.getLayoutRevision()).toBe(0);
    expect(first.layoutSession).not.toBe(second.layoutSession);
  } finally {
    vi.unstubAllGlobals();
  }
});
