import { expect, it, vi } from 'vitest';
import { PluginReaderSession, type PluginReaderAdapter } from './reader-session';
import { AnnotationPageTooLargeError, type ReaderRepository } from '../../repositories/reader-repository';
import type { Bookmark, Chapter, Novel, Paragraph } from '../../domain/types';
import { bookmarkRevision, ResourceRevisionConflictError } from '../../domain/resource-revisions';
import type { UiJson } from '@boaa/extension-contracts/ui-json';
function fixture() {
  let revision = 'r';
  const bookmark: Bookmark = {
    id: 'b',
    novelId: 'book',
    chapterId: 'ch',
    paragraphId: 'p',
    label: 'user',
    progress: 0,
    scrollTop: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const repo = {
    capabilities: { backend: 'hosted' },
    getNovel: vi.fn(async () => ({ activeContentRevisionId: revision }) as Novel),
    getParagraph: vi.fn(
      async () => ({ id: 'p', novelId: 'book', chapterId: 'ch', text: 'hello world', textHash: 'hash' }) as Paragraph,
    ),
    listAnnotationPage: vi.fn(async (_book: string, _kind: string, _after?: string) => ({
      entries: [bookmark],
      nextAfter: null as string | null,
    })),
    listBookmarks: vi.fn(async () => [bookmark]),
    listHighlights: vi.fn(async () => []),
    listNotes: vi.fn(async () => []),
    saveBookmark: vi.fn(async () => {}),
    saveHighlight: vi.fn(async () => {}),
    saveNote: vi.fn(async () => {}),
    deleteBookmark: vi.fn(async () => {}),
    deleteHighlight: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
  };
  const changed = vi.fn();
  const session = new PluginReaderSession({
    bookId: 'book',
    chapterId: 'ch',
    contentRevision: 'r',
    chapters: [{ id: 'ch', novelId: 'book' } as Chapter],
    repository: repo as unknown as ReaderRepository,
    state: () => null,
    start: () => undefined,
    annotationsChanged: changed,
  } satisfies PluginReaderAdapter);
  const call = (
    method: string,
    input: UiJson,
    owner = 'one',
    signal = new AbortController().signal,
    authorize = async () => {},
  ) => session.call(owner, 'reader.annotations.' + method, input, signal, authorize, 'stable-installation');
  const handle = async () =>
    ((await call('list', { kind: 'bookmark' })) as { entries: { handle: string }[] }).entries[0].handle;
  return {
    session,
    repo,
    bookmark,
    changed,
    call,
    handle,
    replace: () => {
      revision = 'new';
    },
  };
}
it('updates only a listed current-book snapshot using existing CAS; handles are single use', async () => {
  const f = fixture(),
    handle = await f.handle();
  await f.call('update', { handle, fields: { label: 'new' } });
  expect(f.repo.saveBookmark).toHaveBeenCalledWith(
    { ...f.bookmark, label: 'new' },
    { expectedRevision: bookmarkRevision(f.bookmark), expectedContentRevision: 'r' },
  );
  expect(f.changed).toHaveBeenCalledOnce();
  await expect(f.call('delete', { handle })).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
});
it('rejects fabricated, cross-instance and superseded handles and arbitrary target fields', async () => {
  const f = fixture(),
    handle = await f.handle();
  await expect(f.call('delete', { handle }, 'other')).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
  await expect(f.call('update', { handle, fields: { label: 'x', novelId: 'other' } })).rejects.toThrow(
    'INVALID_ARGUMENT',
  );
  await f.handle();
  await expect(f.call('delete', { handle })).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
  expect(f.repo.deleteBookmark).not.toHaveBeenCalled();
});
it.each(['bookmark', 'note', 'highlight'])(
  'creates %s with host identity and verified paragraph, without overwriting an existing entity',
  async (kind) => {
    const f = fixture();
    const fields: UiJson =
      kind === 'bookmark' ? { label: 'title' } : kind === 'note' ? { body: 'memo' } : { quote: 'hello', color: 'blue' };
    await f.call('create', { requestId: 'once', kind, paragraphId: 'p', textHash: 'hash', fields });
    const save = kind === 'bookmark' ? f.repo.saveBookmark : kind === 'note' ? f.repo.saveNote : f.repo.saveHighlight;
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ novelId: 'book', paragraphId: 'p', chapterId: 'ch' }),
      expect.objectContaining({ expectedContentRevision: 'r' }),
    );
    expect(f.changed).toHaveBeenCalledOnce();
    f.session.close();
    expect(f.repo.deleteBookmark).not.toHaveBeenCalled();
  },
);
it('rejects stale paragraphs, content replacement, and quotes absent from the source', async () => {
  const f = fixture();
  await expect(
    f.call('create', {
      requestId: 'once',
      kind: 'note',
      paragraphId: 'p',
      textHash: 'wrong',
      fields: { body: 'memo' },
    }),
  ).rejects.toThrow('CONTENT_CHANGED');
  await expect(
    f.call('create', {
      requestId: 'once',
      kind: 'highlight',
      paragraphId: 'p',
      textHash: 'hash',
      fields: { quote: 'not present', color: 'blue' },
    }),
  ).rejects.toThrow('INVALID_ARGUMENT');
  const handle = await f.handle();
  f.replace();
  await expect(f.call('delete', { handle })).rejects.toThrow('CONTENT_CHANGED');
  expect(f.repo.saveNote).not.toHaveBeenCalled();
  expect(f.repo.deleteBookmark).not.toHaveBeenCalled();
});
it.each(['abort', 'revoke', 'close', 'permission'])(
  'does not dispatch a write if %s happens during validation',
  async (reason) => {
    const f = fixture(),
      abort = new AbortController();
    f.repo.getParagraph.mockImplementationOnce(async () => {
      if (reason === 'abort') abort.abort();
      if (reason === 'revoke') f.session.revoke('one');
      if (reason === 'close') f.session.close();
      return { id: 'p', novelId: 'book', chapterId: 'ch', text: 'hello', textHash: 'hash' } as Paragraph;
    });
    let auth = 0;
    await expect(
      f.call(
        'create',
        { requestId: 'once', kind: 'note', paragraphId: 'p', textHash: 'hash', fields: { body: 'memo' } },
        'one',
        abort.signal,
        async () => {
          if (reason === 'permission' && ++auth > 1) throw Error('PERMISSION_DENIED');
        },
      ),
    ).rejects.toThrow();
    expect(f.repo.saveNote).not.toHaveBeenCalled();
  },
);
it('does not retry a conflict or ambiguous write and preserves the host refresh after a dispatched write', async () => {
  const f = fixture(),
    handle = await f.handle();
  f.repo.saveBookmark.mockRejectedValueOnce(new ResourceRevisionConflictError('bookmark', 'old', 'new'));
  await expect(f.call('update', { handle, fields: { label: 'x' } })).rejects.toThrow('ANNOTATION_CONFLICT');
  expect(f.repo.saveBookmark).toHaveBeenCalledOnce();
  expect(f.changed).not.toHaveBeenCalled();
  const next = await f.handle();
  f.repo.deleteBookmark.mockImplementationOnce(async () => {
    f.session.close();
  });
  await expect(f.call('delete', { handle: next })).rejects.toThrow('READER_CONTEXT_STALE');
  expect(f.repo.deleteBookmark).toHaveBeenCalledOnce();
  expect(f.changed).toHaveBeenCalledOnce();
});
it('bounds snapshot output and does not expose other books', async () => {
  const f = fixture();
  f.repo.listAnnotationPage.mockResolvedValueOnce({ entries: [{ ...f.bookmark, novelId: 'other' }], nextAfter: null });
  await expect(f.handle()).rejects.toThrow('ANNOTATION_LIMIT');
  f.repo.listAnnotationPage.mockResolvedValueOnce({
    entries: Array.from({ length: 17 }, () => f.bookmark),
    nextAfter: null,
  });
  await expect(f.handle()).rejects.toThrow('ANNOTATION_LIMIT');
});

it('uses a stable creation ID for a repeated request key across controller instances', async () => {
  const f = fixture();
  const input = {
    requestId: 'unique-intent',
    kind: 'note',
    paragraphId: 'p',
    textHash: 'hash',
    fields: { body: 'memo' },
  };
  await f.call('create', input, 'first-instance');
  await f.call('create', input, 'second-instance');
  const calls = f.repo.saveNote.mock.calls as unknown as [Record<string, unknown>, Record<string, unknown>][];
  expect(calls[0][0].id).toBe(calls[1][0].id);
  expect(calls[0][1]).toMatchObject({ createOnly: true });
});

it('rejects empty content before sending any write', async () => {
  const f = fixture(),
    handle = await f.handle();
  await expect(f.call('update', { handle, fields: { label: '   ' } })).rejects.toThrow('INVALID_ARGUMENT');
  expect(f.repo.saveBookmark).not.toHaveBeenCalled();
});

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
  'never dispatches after cancellation at microtask depth %s',
  async (depth) => {
    const f = fixture(),
      abort = new AbortController(),
      handle = await f.handle();
    const events: string[] = [];
    let reads = 0;
    const cancel = (remaining: number) =>
      queueMicrotask(() => {
        if (remaining > 0) cancel(remaining - 1);
        else {
          events.push('abort');
          abort.abort();
        }
      });
    f.repo.getNovel.mockImplementation(async () => {
      if (++reads === 2) cancel(depth);
      return { activeContentRevisionId: 'r' } as Novel;
    });
    f.repo.saveBookmark.mockImplementation(async () => {
      events.push('write');
    });
    await f
      .call('update', { handle, fields: { label: 'new' } }, 'one', abort.signal)
      .catch((error) => expect(error.message).toBe('READER_CONTEXT_STALE'));
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(events).toContain('abort');
    if (events.includes('write')) expect(events.indexOf('write')).toBeLessThan(events.indexOf('abort'));
  },
);

it('walks more than 128 annotations using bounded, one-use, owner/kind-scoped pages', async () => {
  const f = fixture();
  const all = Array.from({ length: 145 }, (_, i) => ({ ...f.bookmark, id: `b${String(i).padStart(3, '0')}` }));
  f.repo.listAnnotationPage.mockImplementation(async (_book, _kind, after) => {
    const rows = all.filter((row) => !after || row.id > after).slice(0, 16);
    return { entries: rows, nextAfter: rows.at(-1)!.id === all.at(-1)!.id ? null : rows.at(-1)!.id };
  });
  type Page = { entries: { handle: string; value: Bookmark }[]; nextCursor: string | null };
  let page = (await f.call('list', { kind: 'bookmark' })) as unknown as Page;
  const ids = page.entries.map((entry) => entry.value.id);
  const first = page.entries[0].handle;
  const token = page.nextCursor!;
  await expect(f.call('list', { kind: 'bookmark', cursor: token }, 'other')).rejects.toThrow(
    'ANNOTATION_HANDLE_INVALID',
  );
  await expect(f.call('list', { kind: 'note', cursor: token })).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
  while (page.nextCursor) {
    page = (await f.call('list', { kind: 'bookmark', cursor: page.nextCursor })) as unknown as Page;
    ids.push(...page.entries.map((entry) => entry.value.id));
  }
  expect(ids).toEqual(all.map((row) => row.id));
  expect(f.repo.listBookmarks).not.toHaveBeenCalled();
  await expect(f.call('list', { kind: 'bookmark', cursor: token })).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
  await expect(f.call('delete', { handle: first })).rejects.toThrow('ANNOTATION_HANDLE_INVALID');
  await f.call('delete', { handle: page.entries[0].handle });
});

it.each(['restart', 'revoke', 'close', 'revision'])('invalidates annotation paging on %s', async (reason) => {
  const f = fixture();
  f.repo.listAnnotationPage.mockResolvedValue({ entries: [f.bookmark], nextAfter: f.bookmark.id });
  const page = (await f.call('list', { kind: 'bookmark' })) as { nextCursor: string };
  if (reason === 'restart') await f.call('list', { kind: 'bookmark' });
  if (reason === 'revoke') f.session.revoke('one');
  if (reason === 'close') f.session.close();
  if (reason === 'revision') f.replace();
  await expect(f.call('list', { kind: 'bookmark', cursor: page.nextCursor })).rejects.toThrow();
  expect(f.repo.listAnnotationPage).toHaveBeenCalledTimes(reason === 'restart' ? 2 : 1);
});

it('reports an oversized stored annotation without silently skipping it', async () => {
  const f = fixture();
  f.repo.listAnnotationPage.mockRejectedValueOnce(new AnnotationPageTooLargeError());
  await expect(f.call('list', { kind: 'bookmark' })).rejects.toThrow('ANNOTATION_LIMIT');
});
it('does not expose a page or mint handles after revocation during the read', async () => {
  const f = fixture();
  f.repo.listAnnotationPage.mockImplementationOnce(async () => {
    f.session.revoke('one');
    return { entries: [f.bookmark], nextAfter: null };
  });
  await expect(f.call('list', { kind: 'bookmark' })).rejects.toThrow('READER_CONTEXT_STALE');
});
