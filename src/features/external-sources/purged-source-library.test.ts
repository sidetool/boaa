import {
  pendingSourceStreamPreferences,
  recoverSourceStreamVisits,
  stageSourceStreamVisit,
} from '../../external-sources/source-stream-visit-journal';
import { readSourceStreamPosition, saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import { externalItemKeyId } from '../../external-sources/contracts';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import {
  ExternalSourceLocalStateStore,
  externalSourceSubscriptionId,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import { releasePreferenceId } from '../../external-sources/source-user-state';
import { loadSourceLibrary } from '../../features/external-sources/source-library-snapshot';
import { useSourceLibraryLinks } from '../../features/external-sources/use-source-library-links';
import { testNovel } from '../../features/book-workspace/book-workspace-test-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const source = { connectorId: 'synthetic.source', accountConnectionId: 'account', remoteId: 'episode' };
const now = '2026-10-01T00:00:00.000Z';
const work = {
  id: externalSourceSubscriptionId(source.connectorId, source.accountConnectionId, 'work'),
  connectorId: source.connectorId,
  accountConnectionId: source.accountConnectionId,
  collectionRemoteId: 'work',
  navigationRef: 'work',
  title: 'Synthetic work',
  thumbnailUrl: 'data:image/png;base64,AQID',
  knownReleaseIds: ['episode'],
  newReleaseIds: [],
  availableReleaseCount: 1,
  createdAt: now,
  updatedAt: now,
  lastCheckedAt: now,
  schemaVersion: 1 as const,
};
const link = { id: 'link', source, collectionRemoteId: 'work', localBookId: 'book', linkedAt: now };
beforeEach(async () => {
  await resetExternalSourceLocalStateForTests();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});

it('full refresh retires a purged downloaded work and its stream history', async () => {
  const state = new ExternalSourceLocalStateStore();
  await state.saveSubscription(work);
  await state.saveLink(link);
  await state.saveReleasePreferences([
    {
      id: releasePreferenceId(source),
      kind: 'releasePreference',
      source,
      collectionRemoteId: 'work',
      read: true,
      readingMode: 'stream',
      lastReadAt: now,
      readChangedAt: now,
      updatedAt: now,
      lastReadWork: { title: 'Synthetic work' },
    },
  ]);
  const before = await loadSourceLibrary({
    state,
    listNovels: async () => [testNovel({ id: 'book', deletedAt: now })],
  });
  expect(before.links).toHaveLength(1);
  expect(before.subscriptions).toEqual([work]);
  const after = await loadSourceLibrary({ state, listNovels: async () => [] });
  expect(after.links).toEqual([]);
  expect(after.subscriptions).toEqual([]);
  expect((await state.listReleasePreferences())[0].lastReadAt).toBeUndefined();
  expect((await loadSourceLibrary({ state, listNovels: async () => [] })).subscriptions).toEqual([]);
});

it('plain downloaded trash hides the remote projection while preserving subscription', async () => {
  let actual: ReturnType<typeof useSourceLibraryLinks>;
  function Harness() {
    actual = useSourceLibraryLinks([link], [testNovel({ id: 'book', deletedAt: now })], [work]);
    return null;
  }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Harness));
  });
  expect(actual!.unresolvedLibraryWorks).toEqual([]);
  act(() => root!.unmount());
});

async function seedHistory(state: ExternalSourceLocalStateStore) {
  await state.saveSubscription(work);
  await state.saveLink(link);
  stageSourceStreamVisit(undefined, source, 'work', now, undefined, { title: work.title });
}

it('retries interrupted cleanup without erasing a later explicit read or re-add', async () => {
  const state = new ExternalSourceLocalStateStore();
  await seedHistory(state);
  const acknowledge = vi
    .spyOn(state, 'acknowledgeAssociationPurgeIntent')
    .mockRejectedValueOnce(new Error('interrupted'));
  await expect(loadSourceLibrary({ state, listNovels: async () => [] })).rejects.toThrow('interrupted');
  expect(await state.listSubscriptions()).toEqual([]);
  expect(await state.listLinks()).toEqual([]);
  expect(await state.listAssociationPurgeIntents()).toHaveLength(1);
  const resetAt = (await state.listReleasePreferences())[0].readChangedAt!;
  const later = new Date(Date.parse(resetAt) + 1000).toISOString();
  stageSourceStreamVisit(undefined, source, 'work', later, undefined, { title: work.title });
  await state.saveSubscription(work);
  await state.saveLink(link);
  const positionId = JSON.stringify([undefined, externalItemKeyId(source)]);
  vi.spyOn(Date, 'now').mockReturnValueOnce(Date.parse(later));
  saveSourceStreamPosition(positionId, { page: 0, count: 2, fraction: 0, ratio: 1 });
  const snapshot = await loadSourceLibrary({ state, listNovels: async () => [testNovel({ id: 'book' })] });
  expect(snapshot.subscriptions).toEqual([work]);
  expect(snapshot.preferences[0].lastReadAt).toBe(later);
  expect(readSourceStreamPosition(positionId)).toBeDefined();
  expect(await state.listAssociationPurgeIntents()).toEqual([]);
  expect(acknowledge).toHaveBeenCalledTimes(2);
});

it('suppresses stale journal replay after reload but allows a later explicit visit', async () => {
  const state = new ExternalSourceLocalStateStore();
  await seedHistory(state);
  await loadSourceLibrary({ state, listNovels: async () => [] });
  stageSourceStreamVisit(undefined, source, 'work', now, undefined, { title: work.title });
  expect(
    (await loadSourceLibrary({ state: new ExternalSourceLocalStateStore(), listNovels: async () => [] })).subscriptions,
  ).toEqual([]);
  const resetAt = (await state.listReleasePreferences())[0].readChangedAt!;
  stageSourceStreamVisit(undefined, source, 'work', new Date(Date.parse(resetAt) + 1).toISOString(), undefined, {
    title: work.title,
  });
  expect((await loadSourceLibrary({ state, listNovels: async () => [] })).subscriptions).toHaveLength(1);
});

it.each(['active', 'pending'] as const)('preserves history when a second %s association remains', async (kind) => {
  const state = new ExternalSourceLocalStateStore();
  await seedHistory(state);
  await state.saveLink({
    ...link,
    id: 'second',
    localBookId: 'second',
    source: { ...source, remoteId: 'second' },
    ...(kind === 'pending'
      ? {
          pendingImport: {
            operationId: 'import',
            stagedAt: new Date().toISOString(),
            hadExistingLink: false,
            expectedActiveSourceContentHash: 'hash',
          },
        }
      : {}),
  });
  const snapshot = await loadSourceLibrary({
    state,
    listNovels: async () => (kind === 'active' ? [testNovel({ id: 'second' })] : []),
  });
  expect(snapshot.subscriptions).toEqual([work]);
  expect(snapshot.preferences[0].lastReadAt).toBe(now);
  expect(await state.listAssociationPurgeIntents()).toEqual([]);
});

it('a failed catalog cannot retire history, and cleanup isolates the account', async () => {
  const state = new ExternalSourceLocalStateStore();
  await seedHistory(state);
  await expect(
    loadSourceLibrary({
      state,
      listNovels: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
  expect(await state.listLinks()).toEqual([link]);
  const other = { ...source, accountConnectionId: 'other' };
  stageSourceStreamVisit(undefined, other, 'work', now, undefined, { title: 'Other account' });
  const snapshot = await loadSourceLibrary({ state, listNovels: async () => [] });
  expect(snapshot.subscriptions).toHaveLength(1);
  expect(snapshot.subscriptions[0].accountConnectionId).toBe('other');
});

it('does not replay an old visit whose tombstone committed while another visit was saving', async () => {
  await resetExternalSourceLocalStateForTests();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const state = new ExternalSourceLocalStateStore();
  const date = '2026-01-01T00:00:00.000Z';
  const source = { connectorId: 'review.synthetic', remoteId: 'episode' };
  const link = {
    id: 'target-link',
    source,
    collectionRemoteId: 'target-work',
    localBookId: 'purged-book',
    linkedAt: date,
  };
  await state.saveLink(link);
  await state.saveSubscription({
    id: externalSourceSubscriptionId(source.connectorId, undefined, 'target-work'),
    connectorId: source.connectorId,
    collectionRemoteId: 'target-work',
    navigationRef: 'target-work',
    title: 'Target',
    knownReleaseIds: ['episode'],
    newReleaseIds: [],
    availableReleaseCount: 1,
    createdAt: date,
    updatedAt: date,
    lastCheckedAt: date,
    schemaVersion: 1,
  });
  stageSourceStreamVisit(undefined, { ...source, remoteId: 'unrelated' }, 'unrelated-work', date);
  stageSourceStreamVisit(undefined, source, 'target-work', date);
  const replay = state.replaySourceStreamVisit.bind(state);
  let first = true;
  state.replaySourceStreamVisit = async (visit) => {
    const authoritative = await replay(visit);
    if (first) {
      first = false;
      // A concurrent authoritative refresh commits cleanup while recovery awaits
      // the first, unrelated visit save. The second visit is still in its snapshot.
      await state.removeMissingBookLinks([link]);
    }
    return authoritative;
  };
  const recovered = await recoverSourceStreamVisits(undefined, state);
  expect(recovered.find((p) => p.source.remoteId === 'episode')?.lastReadAt).toBeUndefined();
  expect((await state.listReleasePreferences()).find((p) => p.source.remoteId === 'episode')?.read).toBe(false);
  const snapshot = await loadSourceLibrary({ state, listNovels: async () => [] });
  expect(snapshot.subscriptions.some((work) => work.collectionRemoteId === 'target-work')).toBe(false);
  vi.unstubAllGlobals();
});

it('keeps the checkpoint but refuses to project a visit when atomic replay fails', async () => {
  const state = new ExternalSourceLocalStateStore();
  stageSourceStreamVisit(undefined, source, 'work', now, undefined, { title: work.title });
  vi.spyOn(state, 'replaySourceStreamVisit').mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(loadSourceLibrary({ state, listNovels: async () => [] })).rejects.toThrow('storage unavailable');
  expect(await state.listSubscriptions()).toEqual([]);
  expect((await loadSourceLibrary({ state, listNovels: async () => [] })).subscriptions).toHaveLength(1);
});

it('does not replay another account scope when draining an interrupted purge', async () => {
  await resetExternalSourceLocalStateForTests();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const state = new ExternalSourceLocalStateStore();
  const date = '2026-01-01T00:00:00.000Z';
  const source = { connectorId: 'review.synthetic', accountConnectionId: 'first-account-source', remoteId: 'episode' };
  const link = {
    id: 'target-link',
    source,
    collectionRemoteId: 'target-work',
    localBookId: 'purged-book',
    linkedAt: date,
  };
  await state.saveLink(link);
  await state.saveSubscription({
    id: externalSourceSubscriptionId(source.connectorId, source.accountConnectionId, 'target-work'),
    connectorId: source.connectorId,
    accountConnectionId: source.accountConnectionId,
    collectionRemoteId: 'target-work',
    navigationRef: 'target-work',
    title: 'Target',
    knownReleaseIds: ['episode'],
    newReleaseIds: [],
    availableReleaseCount: 1,
    createdAt: date,
    updatedAt: date,
    lastCheckedAt: date,
    schemaVersion: 1,
  });
  stageSourceStreamVisit('host:first-user', source, 'target-work', date);
  await state.removeMissingBookLinks([link], {
    scope: 'host:first-user',
    preferences: pendingSourceStreamPreferences('host:first-user'),
  });
  expect(await state.listAssociationPurgeIntents()).toHaveLength(1);
  // The app closes after the durable transaction and logs into another account.
  // Existing integration hydration replaces links/subscriptions/preferences, but
  // device-only cleanup receipts and scoped journal entries intentionally remain.
  await state.replaceSharedState({ schemaVersion: 1, connections: [], links: [], subscriptions: [] });
  const snapshot = await loadSourceLibrary({ state, settingsScope: 'host:second-user', listNovels: async () => [] });
  expect(snapshot.preferences).toEqual([]);
  expect(snapshot.subscriptions).toEqual([]);
  expect(await state.listAssociationPurgeIntents()).toHaveLength(1);
  expect(pendingSourceStreamPreferences('host:first-user')).toHaveLength(1);
  const firstUser = await loadSourceLibrary({ state, settingsScope: 'host:first-user', listNovels: async () => [] });
  expect(firstUser.preferences).toEqual([]);
  expect(firstUser.subscriptions).toEqual([]);
  expect(pendingSourceStreamPreferences('host:first-user')).toEqual([]);
  expect(await state.listAssociationPurgeIntents()).toEqual([]);
});
