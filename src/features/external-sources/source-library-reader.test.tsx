import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceReadMode } from './source-read-mode';
import { sourceReadingDefaults } from '../../external-sources/source-reading-preferences';
import { useSourceLibraryOpen } from './use-source-library-open';
import { sourceLibraryReaderModel, openSourceLibraryChapter } from './source-library-reader-model';
import type { SourceLibraryReader } from './use-source-library-reader';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './external-source-controller-contract';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';

const item: ExternalSourceItemView = {
  key: { connectorId: 'fixture.text', remoteId: 'episode-2' },
  kind: 'file',
  title: '회차 2',
  release: { title: '회차 2' },
  collection: { remoteId: 'work', title: '작품' },
  importability: 'supported',
  importState: 'available',
  selected: false,
  formatHint: 'TXT',
};
let root: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});
it('keeps classic and image modes unchanged and honors the ui-next text preference', () => {
  const preferences = { ...sourceReadingDefaults, mode: 'stream-save' as const };
  expect(sourceReadMode(item, undefined, preferences)).toBe('download');
  expect(sourceReadMode(item, undefined, { ...preferences, textMode: 'stream' })).toBe('stream');
  expect(sourceReadMode({ ...item, formatHint: 'CBZ' }, undefined, preferences)).toBe('stream-save');
});
function setup(saved = false) {
  const novel = testNovel({ id: 'book', format: 'txt' });
  let link = saved;
  const options = {
    registry: { getExternalSourceStatus: () => ({ state: 'connected' }) },
    state: { listLinks: vi.fn(async () => (link ? [{ source: item.key, localBookId: novel.id }] : [])) },
    getNovel: vi.fn(async () => novel),
    listChapters: vi.fn(async () => (link ? [testChapter(1, { documentSectionId: item.key.remoteId })] : [])),
    openNovel: vi.fn(async () => undefined),
  } as unknown as UseExternalSourceControllerOptions;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const importItems = vi.fn(async () => {
    await gate;
    link = true;
  });
  const prepare = vi.fn(async () => undefined);
  const canOpen = vi.fn(() => true);
  const canImport = vi.fn(() => true);
  let settingsScope: string | undefined;
  let current!: ReturnType<typeof useSourceLibraryOpen>;
  function Harness() {
    current = useSourceLibraryOpen({
      options: { ...options, settingsScope },
      importItems,
      prepare,
      canOpen,
      canImport,
    });
    return null;
  }
  act(() => {
    root = create(<Harness />);
  });
  return {
    options,
    importItems,
    prepare,
    canOpen,
    canImport,
    setScope: (value: string) => {
      settingsScope = value;
    },
    rerender: () => root!.update(<Harness />),
    release,
    markSaved: () => {
      link = true;
    },
    novel,
    get current() {
      return current;
    },
  };
}
it('exposes openingItemKey, deduplicates clicks, saves then opens the requested section', async () => {
  const h = setup();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = h.current.open(item);
  });
  expect(h.current.openingItemKey).toBeDefined();
  expect(h.options.openNovel).not.toHaveBeenCalled();
  await act(async () => {
    await h.current.open(item);
    h.release();
    await pending;
  });
  expect(h.importItems).toHaveBeenCalledExactlyOnceWith([item], true, true, true);
  expect(h.prepare).toHaveBeenCalledWith(h.novel, item, [testChapter(1, { documentSectionId: item.key.remoteId })]);
  expect(h.options.openNovel).toHaveBeenCalledExactlyOnceWith(h.novel, {
    documentSectionId: item.key.remoteId,
    documentSectionTitle: item.release!.title,
    chapters: [testChapter(1, { documentSectionId: item.key.remoteId })],
  });
  expect(h.current.openingItemKey).toBeUndefined();
});
it('reuses a saved section without downloading and does not open after the caller leaves', async () => {
  const saved = setup(true);
  await act(async () => {
    await saved.current.open(item);
  });
  expect(saved.importItems).not.toHaveBeenCalled();
  act(() => root?.unmount());
  root = undefined;
  const h = setup();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = h.current.open(item);
  });
  h.canOpen.mockReturnValue(false);
  await act(async () => {
    h.release();
    await pending;
  });
  expect(h.options.openNovel).not.toHaveBeenCalled();
});
it('adds ordered remote neighbors without mutating persisted chapters and opens them through the import path', async () => {
  const chapter = testChapter(1, { novelId: 'book', documentSectionId: 'episode-2' });
  const items = ['episode-1', 'episode-2', 'episode-3'].map((id) => ({ ...item, key: { ...item.key, remoteId: id } }));
  const source: SourceLibraryReader = { novelId: 'book', items, busy: false, retry: vi.fn(), open: vi.fn() };
  const original = { novel: testNovel({ id: 'book' }), chapter, chapters: [chapter] } as unknown as ReaderScreenModel;
  const result = sourceLibraryReaderModel(original, source);
  expect(result.chapter.index).toBe(2);
  expect(result.chapters.map((c) => c.documentSectionId)).toEqual(['episode-1', 'episode-2', 'episode-3']);
  expect(original.chapters).toEqual([chapter]);
  expect(chapter.index).toBe(1);
  const fallback = vi.fn();
  await openSourceLibraryChapter(result.chapters[0], source, fallback);
  await openSourceLibraryChapter(result.chapters[2], source, fallback);
  expect(source.open).toHaveBeenNthCalledWith(1, items[0]);
  expect(source.open).toHaveBeenNthCalledWith(2, items[2]);
  expect(fallback).not.toHaveBeenCalled();
  expect(sourceLibraryReaderModel(original)).toBe(original);
  await openSourceLibraryChapter(chapter, undefined, fallback);
  expect(fallback).toHaveBeenCalledOnce();
});

it('joins the background import when next is pressed and exposes both phases', async () => {
  const h = setup();
  let prefetch!: Promise<void>;
  await act(async () => {
    prefetch = h.current.prefetch(item);
  });
  expect(h.current.pending).toBeUndefined();
  let opening!: Promise<unknown>;
  await act(async () => {
    opening = h.current.open(item);
  });
  expect(h.current.pending?.phase).toBe('importing');
  await act(async () => {
    h.release();
    await Promise.all([opening, prefetch]);
  });
  expect(h.importItems).toHaveBeenCalledOnce();
  expect(h.options.openNovel).toHaveBeenCalledOnce();
  expect(h.current.pending).toBeUndefined();
});

it('retains home/library prefetch while another import is busy, and joins it on navigation', async () => {
  const h = setup();
  h.canImport.mockReturnValue(false);
  let prefetch!: Promise<void>;
  let opening!: Promise<unknown>;
  await act(async () => {
    prefetch = h.current.prefetch(item);
    opening = h.current.open(item);
  });
  expect(h.importItems).not.toHaveBeenCalled();
  expect(h.current.pending?.phase).toBe('importing');
  await act(async () => {
    h.canImport.mockReturnValue(true);
    h.rerender();
  });
  expect(h.importItems).toHaveBeenCalledOnce();
  await act(async () => {
    h.release();
    await Promise.all([prefetch, opening]);
  });
  expect(h.options.openNovel).toHaveBeenCalledOnce();
});

it('retires queued prefetch when the authenticated storage owner changes', async () => {
  const h = setup();
  h.canImport.mockReturnValue(false);
  let result!: Promise<unknown>;
  await act(async () => {
    result = h.current.prefetch(item).catch((error: Error) => error.name);
  });
  await act(async () => {
    h.setScope('different-owner');
    h.rerender();
  });
  expect(await result).toBe('AbortError');
  await act(async () => {
    h.canImport.mockReturnValue(true);
    h.rerender();
  });
  expect(h.importItems).not.toHaveBeenCalled();
});

it('does not import again if a different batch saves the queued episode', async () => {
  const h = setup();
  h.canImport.mockReturnValue(false);
  h.options.prefetchChapter = vi.fn();
  let prefetch!: Promise<void>;
  await act(async () => {
    prefetch = h.current.prefetch(item);
  });
  await act(async () => {
    h.markSaved();
    h.canImport.mockReturnValue(true);
    h.rerender();
  });
  await act(async () => prefetch);
  expect(h.importItems).not.toHaveBeenCalled();
  expect(h.options.prefetchChapter).toHaveBeenCalledWith(h.novel, expect.anything());
});

it('consumes the prepared metadata snapshot without any foreground catalogue requests', async () => {
  const h = setup(true);
  await act(async () => {
    await h.current.prefetch(item);
  });
  vi.mocked(h.options.getNovel).mockClear();
  vi.mocked(h.options.listChapters).mockClear();
  vi.mocked(h.options.state.listLinks).mockClear();
  await act(async () => {
    await h.current.open(item);
  });
  expect(h.options.getNovel).not.toHaveBeenCalled();
  expect(h.options.listChapters).not.toHaveBeenCalled();
  expect(h.options.state.listLinks).not.toHaveBeenCalled();
  expect(h.options.openNovel).toHaveBeenCalledOnce();
});
it('revalidates prepared metadata after a library mutation', async () => {
  const h = setup(true);
  await act(async () => {
    await h.current.prefetch(item);
  });
  vi.mocked(h.options.getNovel).mockClear();
  Object.assign(h.options, { libraryRevision: 7 });
  await act(async () => {
    h.rerender();
  });
  await act(async () => {
    await h.current.open(item);
  });
  expect(h.options.getNovel).toHaveBeenCalledOnce();
});

it.each([true, false])(
  'never exposes sparse local navigation while the source catalogue is unavailable (loading=%s)',
  async (busy) => {
    const model = {
      novel: testNovel(),
      chapter: testChapter(2),
      chapters: [testChapter(1), testChapter(2), testChapter(6)],
    } as unknown as ReaderScreenModel;
    const source = {
      novelId: model.novel.id,
      items: [],
      busy,
      error: busy ? undefined : 'catalogue failed',
      retry: vi.fn(),
      open: vi.fn(),
    };
    const projected = sourceLibraryReaderModel(model, source);
    expect(projected.chapters).toEqual([model.chapter]);
    expect(projected.navigation).toMatchObject({ busy, error: source.error });
    const fallback = vi.fn();
    await openSourceLibraryChapter(testChapter(6), source, fallback);
    expect(fallback).not.toHaveBeenCalled();
  },
);
