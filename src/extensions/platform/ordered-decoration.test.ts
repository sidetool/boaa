import { expect, it, vi } from 'vitest';
import { OrderedDecoration } from './ordered-decoration';
import type { PluginReaderAdapter } from './reader-session';
import type { PluginReaderContent } from './reader-decoration-runtime';
import type { Paragraph, Chapter, Novel, ParagraphPage } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
function fixture() {
  const paragraphs = Array.from(
    { length: 96 },
    (_, index) =>
      ({
        id: `p${index}`,
        novelId: 'b',
        chapterId: 'c',
        index: index + 1,
        text: index === 0 ? '"open' : index === 95 ? 'close"' : 'inside',
        textHash: `h${index}`,
      }) as Paragraph,
  );
  let revision = 'r';
  const repository = {
    getNovel: vi.fn(async () => ({ activeContentRevisionId: revision }) as Novel),
    getParagraph: vi.fn(async (id: string) => paragraphs.find((p) => p.id === id)),
    getParagraphPage: vi.fn(async (_chapter: string, page: number) =>
      page < 3
        ? ({
            novelId: 'b',
            chapterId: 'c',
            pageIndex: page,
            paragraphs: paragraphs.slice(page * 32, page * 32 + 32),
          } as ParagraphPage)
        : undefined,
    ),
  };
  const adapter: PluginReaderAdapter = {
    bookId: 'b',
    chapterId: 'c',
    contentRevision: 'r',
    chapters: [{ id: 'c', textHash: 'chapter' } as Chapter],
    repository: repository as unknown as ReaderRepository,
    state: () => null,
    start: () => undefined,
  };
  const content = (index: number): PluginReaderContent => ({
    key: 'reader',
    bookId: 'b',
    chapterId: 'c',
    contentRevision: 'r',
    theme: 'light',
    blocks: [{ id: `p${index}`, text: paragraphs[index].text, textHash: `h${index}` }],
  });
  const compute = vi.fn(async (blocks: PluginReaderContent['blocks'], state: UiJson): Promise<UiJson> => {
    let count = (state as { count?: number }).count ?? 0;
    const ranges = blocks.map((block) => {
      count++;
      return { paragraphId: block.id, start: 0, end: block.text.length, styleId: 'ink' };
    });
    return { layers: [{ id: 'ink', palette: { ink: { fontWeight: 700 } }, ranges }], checkpoints: { count } };
  });
  const engine = new OrderedDecoration();
  const abort = new AbortController();
  const guard = vi.fn(async () => {});
  const run = (index: number, key = 'config-1') =>
    engine.run(key, content(index), adapter, abort.signal, guard, compute);
  return {
    engine,
    repository,
    adapter,
    content,
    compute,
    abort,
    guard,
    run,
    replace: () => {
      revision = 'new';
    },
  };
}
it('replays the prefix on a cold mid-chapter jump and uses only a preceding checkpoint on later jumps', async () => {
  const f = fixture();
  const result = (await f.run(70)) as { layers: { ranges: unknown[] }[] };
  expect(f.compute.mock.calls[0][0][0].id).toBe('p0');
  expect(f.compute.mock.calls[4][1]).toEqual({ count: 64 });
  expect(result.layers[0].ranges).toHaveLength(1);
  f.compute.mockClear();
  await f.run(82);
  expect(f.compute.mock.calls[0][0][0].id).toBe('p80');
  expect(f.compute.mock.calls[0][1]).toEqual({ count: 80 });
  f.compute.mockClear();
  await f.run(35);
  expect(f.compute.mock.calls[0][0][0].id).toBe('p32');
  expect(f.compute.mock.calls[0][1]).toEqual({ count: 32 });
});
it('restarts authored state on config, theme, reader or source generation changes', async () => {
  const f = fixture();
  await f.run(70);
  f.compute.mockClear();
  await f.run(70, 'config-2');
  expect(f.compute.mock.calls[0][1]).toEqual({});
  f.compute.mockClear();
  await f.engine.run('config-2', { ...f.content(70), theme: 'dark' }, f.adapter, f.abort.signal, f.guard, f.compute);
  expect(f.compute.mock.calls[0][1]).toEqual({});
  f.compute.mockClear();
  await f.engine.run(
    'config-2',
    { ...f.content(70), key: 'another-reader' },
    f.adapter,
    f.abort.signal,
    f.guard,
    f.compute,
  );
  expect(f.compute.mock.calls[0][1]).toEqual({});
  f.replace();
  await expect(f.run(70)).rejects.toThrow('CONTENT_CHANGED');
});
it.each(['cancel', 'permission', 'source', 'clear'])(
  'does not retain or return late results after %s',
  async (reason) => {
    const f = fixture();
    const original = f.compute.getMockImplementation()!;
    f.compute.mockImplementationOnce(async (...args) => {
      if (reason === 'cancel') f.abort.abort();
      if (reason === 'permission') f.guard.mockRejectedValue(Error('PERMISSION_DENIED'));
      if (reason === 'source') f.replace();
      if (reason === 'clear') f.engine.clear();
      return original(...args);
    });
    await expect(f.run(70)).rejects.toThrow();
  },
);
it('rejects oversized state and invalid off-screen ranges instead of caching them', async () => {
  const f = fixture();
  f.compute.mockResolvedValueOnce({ layers: [], checkpoints: { huge: 'x'.repeat(9000) } });
  await expect(f.run(70)).rejects.toThrow('INVALID_CHECKPOINT');
  f.compute.mockResolvedValueOnce({
    layers: [
      {
        id: 'ink',
        palette: { ink: { color: '#123456' } },
        ranges: [{ paragraphId: 'p0', start: 0, end: 999, styleId: 'ink' }],
      },
    ],
    checkpoints: {},
  });
  await expect(f.run(70)).rejects.toThrow('INVALID_PLUGIN_DECORATION');
});

it('keeps layer identities and palettes independent when composing several batches', async () => {
  const f = fixture();
  const original = f.compute.getMockImplementation()!;
  f.compute.mockImplementation(async (...args) => {
    const value = (await original(...args)) as { layers: UiJson[]; checkpoints: UiJson };
    return {
      ...value,
      layers: [
        ...value.layers,
        {
          id: 'second',
          palette: { ink: { fontStyle: 'italic' } },
          ranges: args[0].map((block) => ({ paragraphId: block.id, start: 0, end: block.text.length, styleId: 'ink' })),
        },
      ],
    };
  });
  const result = (await f.run(70)) as { layers: { id: string; palette: unknown }[] };
  expect(result.layers.map((layer) => layer.id)).toEqual(['ink', 'second']);
  expect(result.layers[0].palette).toEqual({ s0: { fontWeight: 700 } });
  expect(result.layers[1].palette).toEqual({ s0: { fontStyle: 'italic' } });
});
it('does not carry a checkpoint into a different chapter', async () => {
  const f = fixture();
  await f.run(70);
  f.compute.mockClear();
  const paragraph = {
    id: 'next',
    novelId: 'b',
    chapterId: 'next-chapter',
    index: 1,
    text: 'new text',
    textHash: 'next-hash',
  } as Paragraph;
  f.repository.getParagraph.mockResolvedValue(paragraph);
  f.repository.getParagraphPage.mockResolvedValue({
    novelId: 'b',
    chapterId: 'next-chapter',
    pageIndex: 0,
    paragraphs: [paragraph],
  } as ParagraphPage);
  const adapter = {
    ...f.adapter,
    chapterId: 'next-chapter',
    chapters: [{ id: 'next-chapter', textHash: 'next-chapter-hash' } as Chapter],
  };
  await f.engine.run(
    'config-1',
    {
      ...f.content(0),
      chapterId: 'next-chapter',
      blocks: [{ id: paragraph.id, text: paragraph.text, textHash: paragraph.textHash }],
    },
    adapter,
    f.abort.signal,
    f.guard,
    f.compute,
  );
  expect(f.compute.mock.calls[0][1]).toEqual({});
});
