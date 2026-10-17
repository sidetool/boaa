import { expect, it, vi } from 'vitest';
import { PluginReaderSession, type PluginReaderAdapter } from './reader-session';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { Chapter, Novel, ParagraphPage } from '../../domain/types';
const live = () => new AbortController();
function fixture() {
  let revision = 'r1';
  let moving = false;
  const motion = {
    active: () => moving,
    stop: vi.fn(() => {
      moving = false;
    }),
    update: vi.fn(),
  };
  const paragraphs = Array.from({ length: 70 }, (_, index) => ({
    id: `p${index}`,
    novelId: 'book',
    chapterId: 'chapter',
    index,
    text: `quote ${index}`,
    textHash: `h${index}`,
  }));
  const repository = {
    getNovel: vi.fn(async () => ({ activeContentRevisionId: revision }) as Novel),
    getParagraphPage: vi.fn(async (_chapter: string, page: number) =>
      page === 0 ? ({ paragraphs, novelId: 'book', chapterId: 'chapter', pageIndex: 0 } as ParagraphPage) : undefined,
    ),
  };
  const adapter: PluginReaderAdapter = {
    bookId: 'book',
    chapterId: 'chapter',
    contentRevision: 'r1',
    chapters: [{ id: 'chapter', novelId: 'book' } as Chapter],
    repository: repository as unknown as ReaderRepository,
    state: () => ({ bookId: 'book' }),
    start: vi.fn(() => {
      moving = true;
      return motion;
    }),
  };
  const session = new PluginReaderSession(adapter);
  const call = (method: string, input: Record<string, string | number> = {}, owner = 'one', signal = live().signal) =>
    session.call(owner, method, input, signal);
  return {
    session,
    call,
    adapter,
    repository,
    motion,
    change: () => {
      revision = 'r2';
    },
  };
}
it('revokes a live motion synchronously on input release and rejects delayed starts', async () => {
  const f = fixture(),
    input = live();
  const interactionId = f.session.begin('one', input.signal);
  await f.call('reader.auto.start', { interactionId, speed: 7 });
  expect(f.motion.active()).toBe(true);
  input.abort();
  expect(f.motion.active()).toBe(false);
  expect(f.motion.stop).toHaveBeenCalledOnce();
  await expect(f.call('reader.auto.start', { interactionId, speed: 7 })).rejects.toThrow('INPUT_EXPIRED');
});
it('never lets another instance or an old stop control the newer motion', async () => {
  const f = fixture(),
    a = live(),
    b = live();
  const interactionId = f.session.begin('one', a.signal);
  await expect(f.call('reader.auto.start', { interactionId, speed: 5 }, 'two')).rejects.toThrow('INPUT_EXPIRED');
  const old = (await f.call('reader.auto.start', { interactionId, speed: 5 })) as { leaseId: string };
  a.abort();
  const next = f.session.begin('two', b.signal);
  await f.call('reader.auto.start', { interactionId: next, speed: 6 }, 'two');
  await f.call('reader.auto.stop', old);
  expect(f.motion.active()).toBe(true);
  f.session.revoke('two');
  expect(f.motion.active()).toBe(false);
});
it('rejects fabricated input and out of range motion, and closes all capabilities with Reader', async () => {
  const f = fixture();
  await expect(f.call('reader.auto.start', { interactionId: 'fake', speed: 5 })).rejects.toThrow('INPUT_EXPIRED');
  const interactionId = f.session.begin('one', live().signal);
  await expect(f.call('reader.auto.start', { interactionId, speed: 0 })).rejects.toThrow('INVALID_ARGUMENT');
  await f.call('reader.auto.start', { interactionId, speed: 12 });
  f.session.close();
  expect(f.motion.active()).toBe(false);
  await expect(f.call('reader.state.get')).rejects.toThrow('READER_CONTEXT_STALE');
});
it('reads the current book in bounded batches without skips, with instance-bound single-use cursors', async () => {
  const f = fixture();
  const first = (await f.call('reader.content.read')) as { blocks: { id: string }[]; cursor: string };
  expect(first.blocks).toHaveLength(32);
  await expect(f.call('reader.content.read', { cursor: first.cursor }, 'two')).rejects.toThrow('INVALID_CURSOR');
  const second = (await f.call('reader.content.read', { cursor: first.cursor })) as typeof first;
  await expect(f.call('reader.content.read', { cursor: first.cursor })).rejects.toThrow('INVALID_CURSOR');
  const last = (await f.call('reader.content.read', { cursor: second.cursor })) as typeof first;
  expect([...first.blocks, ...second.blocks, ...last.blocks].map((b) => b.id)).toEqual(
    Array.from({ length: 70 }, (_, i) => `p${i}`),
  );
  expect(last.cursor).toBeNull();
});
it('binds search cursors to the exact query and invalidates them when their instance retires', async () => {
  const f = fixture();
  const first = (await f.call('reader.content.search', { query: 'quote 3' })) as {
    blocks: { text: string }[];
    cursor: string;
  };
  expect(first.blocks.every((p) => p.text.includes('quote 3'))).toBe(true);
  await expect(f.call('reader.content.search', { query: 'quote 4', cursor: first.cursor })).rejects.toThrow(
    'INVALID_CURSOR',
  );
  f.session.revoke('one');
  await expect(f.call('reader.content.search', { query: 'quote 3', cursor: first.cursor })).rejects.toThrow(
    'INVALID_CURSOR',
  );
});
it.each(['replace', 'close', 'abort'])(
  'does not deliver content after %s during a pending repository read',
  async (action) => {
    const f = fixture(),
      abort = live();
    f.repository.getParagraphPage.mockImplementationOnce(async () => {
      if (action === 'replace') f.change();
      else if (action === 'close') f.session.close();
      else abort.abort();
      return { paragraphs: [] } as unknown as ParagraphPage;
    });
    await expect(f.call('reader.content.read', {}, 'one', abort.signal)).rejects.toThrow(
      action === 'replace' ? 'CONTENT_CHANGED' : 'READER_CONTEXT_STALE',
    );
  },
);
it('rejects overlapping cursor reads and retirement during a read without leaving reusable cursors', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const read = f.repository.getParagraphPage.getMockImplementation()!;
  f.repository.getParagraphPage.mockImplementationOnce(async (...args) => {
    await held;
    return read(...args);
  });
  const pending = f.call('reader.content.read');
  await vi.waitFor(() => expect(f.repository.getParagraphPage).toHaveBeenCalled());
  await expect(f.call('reader.content.read')).rejects.toThrow('CONTENT_BUSY');
  f.session.revoke('one');
  release();
  await expect(pending).rejects.toThrow('READER_CONTEXT_STALE');
});
