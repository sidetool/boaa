import { recoverLinkedWorkMetadata } from './recover-linked-work-metadata';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { useShownSourceMetadata } from '../../ui-next/library/use-shown-source-metadata';
import type { LibraryWorkItem } from '../library/library-work-order';
import { expect, it, vi } from 'vitest';
import { createSourceWorkMetadataLoader, sourceWorkMetadata, knownWorkTitle } from './source-work-metadata';
import { fixture, episode, visit, deferred } from './source-command-test-fixtures';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { recoverStreamLibrary } from './recover-stream-library';
import { withSourceMetadata } from '../library/library-source-metadata';
import { buildLibraryBookView } from '../library/library-screen-model';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
function setup() {
  const f = fixture();
  let record: ExternalSourceSubscriptionRecord = {
    id: 'subscription',
    connectorId: 'fixture.source',
    accountConnectionId: 'account',
    collectionRemoteId: 'e5bf004fff21abcd',
    navigationRef: 'e5bf004fff21abcd',
    title: 'e5bf004fff21abcd',
    knownReleaseIds: [],
    newReleaseIds: [],
    availableReleaseCount: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    lastCheckedAt: '2026-01-01',
    schemaVersion: 1,
  };
  f.options.state.listSubscriptions = vi.fn(async () => [record]);
  f.options.state.saveSubscription = vi.fn(async (next) => {
    record = next;
  });
  const publish = vi.fn();
  return {
    ...f,
    publish,
    loader: createSourceWorkMetadataLoader(f.options, publish),
    get record() {
      return record;
    },
    set record(next) {
      record = next;
    },
  };
}
it('never exposes a raw id/hash as the work title, including linked saved books', () => {
  const h = setup();
  expect(sourceWorkMetadata(h.record)).toMatchObject({ title: '', titleUnknown: true });
  expect(knownWorkTitle(['e5bf004fff21abcd', 'Fixture Work'])).toBe('Fixture Work');
  const book = buildLibraryBookView(testNovel({ title: h.record.title }), {
    hasReadActivity: () => true,
    isFinished: () => false,
  });
  const work = { ...h.record, localBookId: book.novel.id, ...sourceWorkMetadata(h.record) };
  expect(withSourceMetadata(book, [work])).toMatchObject({ titleUnknown: true, novel: { title: '' } });
  expect(withSourceMetadata(book, [{ ...work, title: 'Resolved Work', author: 'Fixture Author' }])).toMatchObject({
    titleUnknown: false,
    novel: { title: 'Resolved Work', author: 'Fixture Author' },
  });
});
it('is lazy, uses the cache first and persists title and author without a network request', async () => {
  const h = setup();
  vi.mocked(h.options.state.getCachePage).mockResolvedValue({
    detail: { title: 'Cached Work', author: 'Fixture Author' },
    items: [],
  } as never);
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  await h.loader.request(h.record);
  expect(h.record).toMatchObject({ title: 'Cached Work', titleUnknown: false, author: 'Fixture Author' });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
  expect(h.options.state.saveSubscription).toHaveBeenCalledOnce();
});
it('fetches missing detail once and preserves newer user overrides and shelves when persisting', async () => {
  const h = setup();
  const gate = deferred<never>();
  h.registry.listExternalSource.mockImplementation(() => gate.promise);
  const original = h.record;
  const first = h.loader.request(original);
  const second = h.loader.request(original);
  expect(second).toBe(first);
  await vi.waitFor(() => expect(h.registry.listExternalSource).toHaveBeenCalledOnce());
  h.record = { ...h.record, titleOverride: 'Chosen title', shelfIds: ['shelf'] };
  gate.resolve({ detail: { title: 'Source Work', author: 'Fixture Author' }, items: [] } as never);
  await first;
  expect(h.record).toMatchObject({
    title: 'Chosen title',
    author: 'Fixture Author',
    shelfIds: ['shelf'],
    titleUnknown: false,
  });
  await h.loader.request(original);
  expect(h.registry.listExternalSource).toHaveBeenCalledOnce();
});
it('leaves unknown metadata explicit on failure and does not retry on each render', async () => {
  const h = setup();
  h.registry.listExternalSource.mockRejectedValue(new Error('unavailable'));
  await h.loader.request(h.record);
  await h.loader.request(h.record);
  expect(h.registry.listExternalSource).toHaveBeenCalledOnce();
  expect(sourceWorkMetadata(h.record).titleUnknown).toBe(true);
  h.loader.dispose();
  await h.loader.request({ ...h.record, id: 'other' });
  expect(h.registry.listExternalSource).toHaveBeenCalledOnce();
});
it('recovers metadata from a recorded work visit and leaves genuinely unknown titles empty', async () => {
  const f = fixture();
  f.options.state.listSubscriptions = vi.fn(async () => []);
  f.options.state.saveSubscription = vi.fn(async () => undefined);
  const read = {
    ...visit,
    readingMode: 'stream' as const,
    read: true,
    lastReadAt: '2026-10-01',
    updatedAt: '2026-10-01',
  };
  const unknown = await recoverStreamLibrary(f.options, [], [read]);
  expect(unknown[0]).toMatchObject({ title: '', titleUnknown: true });
  const recovered = await recoverStreamLibrary(
    f.options,
    [],
    [{ ...read, lastReadWork: { title: 'Visited Work', author: 'Fixture Author' } }],
  );
  expect(recovered[0]).toMatchObject({ title: 'Visited Work', author: 'Fixture Author', titleUnknown: false });
  expect(f.registry.listExternalSource).not.toHaveBeenCalled();
});
it('uses collection metadata when the source omits the detail title', async () => {
  const h = setup();
  h.registry.listExternalSource.mockResolvedValue({
    items: [
      {
        ...episode(),
        collection: { remoteId: h.record.collectionRemoteId, title: 'Collection Work' },
        author: 'Fixture Author',
      },
    ],
  } as never);
  await h.loader.request(h.record);
  expect(h.record).toMatchObject({ title: 'Collection Work', author: 'Fixture Author', titleUnknown: false });
});

it('requests only the unknown metadata included in the visible screen adapter', async () => {
  const request = vi.fn(async () => undefined);
  function Harness({ items }: { items: LibraryWorkItem[] }) {
    useShownSourceMetadata(items);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Harness, { items: [] }));
  });
  expect(request).not.toHaveBeenCalled();
  const item = {
    kind: 'external',
    key: 'work',
    work: { titleUnknown: true, requestMetadata: request },
  } as unknown as LibraryWorkItem;
  await act(async () => {
    root.update(createElement(Harness, { items: [item] }));
  });
  expect(request).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
it('serializes visible metadata requests on the same source', async () => {
  const h = setup();
  const gate = deferred<never>();
  h.registry.listExternalSource.mockImplementationOnce(() => gate.promise);
  const first = h.loader.request(h.record);
  const second = h.loader.request({ ...h.record, id: 'second' });
  await vi.waitFor(() => expect(h.registry.listExternalSource).toHaveBeenCalledOnce());
  gate.resolve({ items: [], detail: { title: 'Work' } } as never);
  await Promise.all([first, second]);
  expect(h.registry.listExternalSource).toHaveBeenCalledTimes(2);
});

it('creates a repair target for a saved source book with an opaque title and no subscription', async () => {
  const h = setup();
  h.options.state.listSubscriptions = vi.fn(async () => []);
  const novel = testNovel({ title: 'e5bf004fff21abcd' });
  const records = await recoverLinkedWorkMetadata(
    h.options,
    [],
    [{ id: 'link', source: episode().key, localBookId: novel.id, collectionRemoteId: 'work', linkedAt: '2026-01-01' }],
    [novel],
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ title: '', titleUnknown: true });
  expect(h.registry.listExternalSource).not.toHaveBeenCalled();
});
