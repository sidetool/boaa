import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { fixture, episode, deferred } from './source-command-test-fixtures';
import { prepareSourceLibraryImporter } from './prepare-source-library-importer';
import { useSourceLibraryReader } from './use-source-library-reader';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
vi.mock('./prepare-source-library-importer', () => ({ prepareSourceLibraryImporter: vi.fn(async () => undefined) }));
it('resolves a persisted document-series section after reload and loads the full catalog', async () => {
  const f = fixture();
  const item = episode();
  vi.mocked(f.options.getNovel).mockResolvedValue(testNovel({ id: 'book', format: 'txt' }));
  vi.mocked(f.options.state.listLinks).mockResolvedValue([
    { id: 'link', source: item.key, localBookId: 'book', collectionRemoteId: 'work', linkedAt: '2026-01-01' },
  ]);
  const options = {
    ...f.options,
    readingTarget: { novelId: 'book', sectionId: externalDocumentReleaseSourceId(item.key, 'work') },
  };
  const open = vi.fn();
  const prefetch = vi.fn(async () => undefined);
  let current: ReturnType<typeof useSourceLibraryReader>;
  function Harness() {
    current = useSourceLibraryReader(options, open, false, prefetch);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  try {
    expect(current?.novelId).toBe('book');
    expect(current?.items.map((item) => item.key.remoteId)).toEqual(['one', 'two']);
    expect(f.registry.listExternalSource).toHaveBeenCalledOnce();
    expect(prefetch).toHaveBeenCalledExactlyOnceWith(current?.items[1]);
    await current?.open(current.items[1]);
    expect(open).toHaveBeenCalledWith(current?.items[1]);
    open.mockRejectedValue(new Error('fixture open failed'));
    await act(async () => {
      expect(await current?.open(current.items[1])).toBe(false);
    });
    expect(current?.error).toBe('fixture open failed');
    open.mockResolvedValue(true);
    await act(async () => {
      await current?.retry();
    });
    expect(open).toHaveBeenCalledTimes(3);
    expect(current?.error).toBeUndefined();
    expect(f.registry.listExternalSource).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it('warms the next episode when a library entry catalog arrives later, even with automatic downloads disabled', async () => {
  vi.mocked(prepareSourceLibraryImporter).mockClear();
  const f = fixture();
  const items = [episode(), episode('two'), { ...episode('three'), release: { title: 'three', chapterNumber: 3 } }];
  const catalog = deferred<{ items: typeof items }>();
  f.registry.listExternalSource.mockReturnValue(catalog.promise);
  vi.mocked(f.options.getNovel).mockResolvedValue(testNovel({ id: 'book', format: 'txt' }));
  vi.mocked(f.options.state.listLinks).mockResolvedValue(
    items.map((item) => ({
      id: item.key.remoteId,
      source: item.key,
      localBookId: 'book',
      collectionRemoteId: 'work',
      linkedAt: '2026-01-01',
    })),
  );
  const options = {
    ...f.options,
    downloadPolicy: { autoNext: false, nextCount: 1 as const, retentionEnabled: false, keepRead: 5 as const },
    readingTarget: { novelId: 'book', sectionId: externalDocumentReleaseSourceId(items[0]!.key, 'work') },
  };
  const prefetch = vi.fn(async () => undefined);
  function Harness() {
    useSourceLibraryReader(options, vi.fn(), false, prefetch);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  try {
    expect(prefetch).not.toHaveBeenCalled();
    expect(prepareSourceLibraryImporter).toHaveBeenCalled();
    await act(async () => catalog.resolve({ items }));
    expect(prefetch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: items[1]!.key }));
    await act(async () => root.update(<Harness />));
    expect(prefetch).toHaveBeenCalledOnce();
    // Outline, detail and next/previous all converge on this reading target.
    options.readingTarget = { novelId: 'book', sectionId: externalDocumentReleaseSourceId(items[1]!.key, 'work') };
    await act(async () => root.update(<Harness />));
    expect(prefetch).toHaveBeenLastCalledWith(expect.objectContaining({ key: items[2]!.key }));
    expect(prefetch).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
