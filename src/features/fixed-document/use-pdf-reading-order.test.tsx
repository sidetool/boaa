import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { block, deferred, novel, repository, revision } from './pdf-text-controller-test-fixtures';
import { usePdfReadingOrder } from './use-pdf-reading-order';
import { documentTextBlockFingerprint } from '../../domain/document-text-order';
async function harness(repo = repository()) {
  let snapshot!: ReturnType<typeof usePdfReadingOrder>;
  const text = { ensurePdfNativeText: vi.fn(async () => {}), replacePageBlocks: vi.fn() };
  const pages = new Map();
  function Probe({ page = 0 }) {
    snapshot = usePdfReadingOrder({ novel, pages, pageIndex: page, searchOpen: true, repository: repo, text });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    repo,
    text,
    get current() {
      return snapshot;
    },
    update: async (page: number) => {
      await act(async () => root.update(<Probe page={page} />));
    },
    dispose: () => act(() => root.unmount()),
  };
}
it('discards a late draft when its page changes away and back', async () => {
  const repo = repository();
  const pending = deferred<ReturnType<typeof revision> | undefined>();
  vi.mocked(repo.findReadyRevision).mockReturnValue(pending.promise);
  const h = await harness(repo);
  let open!: Promise<void>;
  await act(async () => {
    open = h.current.openReadingOrderEditor();
  });
  await h.update(1);
  await h.update(0);
  await act(async () => {
    pending.resolve(revision());
    await open;
  });
  expect(h.current.readingOrderOpen).toBe(false);
  expect(h.current.readingOrderRevision).toBeUndefined();
  expect(repo.getRawBlocks).not.toHaveBeenCalled();
  h.dispose();
});
it('closing a pending editor prevents it from resurrecting a draft', async () => {
  const repo = repository();
  const pending = deferred<ReturnType<typeof revision> | undefined>();
  vi.mocked(repo.findReadyRevision).mockReturnValue(pending.promise);
  const h = await harness(repo);
  let open!: Promise<void>;
  await act(async () => {
    open = h.current.openReadingOrderEditor();
  });
  act(() => h.current.setReadingOrderOpen(false));
  await act(async () => {
    pending.resolve(revision());
    await open;
  });
  expect(h.current.readingOrderRevision).toBeUndefined();
  h.dispose();
});
it('saves exclusion fingerprints before publishing filtered blocks and resets from raw blocks', async () => {
  const repo = repository();
  const raw = [
    block(),
    {
      ...block(),
      id: 'second',
      text: 'Second synthetic paragraph',
      normalizedText: 'Second synthetic paragraph',
      order: 1,
    },
  ];
  vi.mocked(repo.findReadyRevision).mockResolvedValue(revision());
  vi.mocked(repo.getRawBlocks).mockResolvedValue(raw);
  vi.mocked(repo.getBlocks).mockResolvedValue([raw[1]]);
  const saved = deferred<void>();
  vi.mocked(repo.saveOrderOverride).mockReturnValue(saved.promise);
  const h = await harness(repo);
  await act(async () => h.current.openReadingOrderEditor());
  act(() => h.current.toggleReadingOrderExcluded(raw[0].id));
  let save!: Promise<void>;
  await act(async () => {
    save = h.current.saveReadingOrder();
  });
  expect(h.text.replacePageBlocks).not.toHaveBeenCalled();
  const override = vi.mocked(repo.saveOrderOverride).mock.calls[0][0];
  expect(override.excludedBlockFingerprints).toEqual([documentTextBlockFingerprint(raw[0])]);
  await act(async () => {
    saved.resolve();
    await save;
  });
  expect(h.text.replacePageBlocks).toHaveBeenLastCalledWith(0, [raw[1]]);
  vi.mocked(repo.getOrderOverride).mockResolvedValue(override);
  await act(async () => h.current.openReadingOrderEditor());
  expect(h.current.readingOrderExcludedIds).toEqual(new Set([raw[0].id]));
  await act(async () => h.current.resetReadingOrder());
  expect(repo.removeOrderOverride).toHaveBeenCalledWith(override.id);
  expect(h.text.replacePageBlocks).toHaveBeenLastCalledWith(0, raw);
  h.dispose();
});
it('does not write an override after the editor page changes while loading the existing override', async () => {
  const repo = repository();
  vi.mocked(repo.findReadyRevision).mockResolvedValue(revision());
  vi.mocked(repo.getRawBlocks).mockResolvedValue([block()]);
  const h = await harness(repo);
  await act(async () => h.current.openReadingOrderEditor());
  const pending = deferred<undefined>();
  vi.mocked(repo.getOrderOverride).mockReturnValue(pending.promise);
  let save!: Promise<void>;
  await act(async () => {
    save = h.current.saveReadingOrder();
  });
  await h.update(1);
  await act(async () => {
    pending.resolve(undefined);
    await save;
  });
  expect(repo.saveOrderOverride).not.toHaveBeenCalled();
  expect(h.text.replacePageBlocks).not.toHaveBeenCalled();
  h.dispose();
});

it('rejects retained old-page commands before they mutate or invalidate the new editor', async () => {
  const repo = repository();
  const h = await harness(repo);
  const old = h.current;
  await h.update(1);
  const pending = deferred<ReturnType<typeof revision> | undefined>();
  vi.mocked(repo.findReadyRevision).mockReturnValue(pending.promise);
  vi.mocked(repo.getRawBlocks).mockResolvedValue([block(1)]);
  let open!: Promise<void>;
  await act(async () => {
    open = h.current.openReadingOrderEditor();
  });
  await act(async () => {
    await old.openReadingOrderEditor();
    old.setReadingOrderOpen(false);
    old.moveReadingOrderBlock(0, 1);
    old.toggleReadingOrderExcluded('block-1');
  });
  expect(h.current.readingOrderOpen).toBe(true);
  expect(repo.findReadyRevision).toHaveBeenCalledOnce();
  await act(async () => {
    pending.resolve(revision(1));
    await open;
  });
  expect(h.current.readingOrderRevision?.pageIndex).toBe(1);
  expect(h.current.readingOrderStatus).toBe('idle');
  expect(h.current.readingOrderExcludedIds.size).toBe(0);
  h.dispose();
});
