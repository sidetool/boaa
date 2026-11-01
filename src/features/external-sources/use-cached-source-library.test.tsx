import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExternalSourceLocalState, ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { useCachedSourceLibrary } from './use-cached-source-library';

const work: ExternalSourceSubscriptionRecord = {
  id: 'stream',
  connectorId: 'fixture',
  collectionRemoteId: 'series',
  navigationRef: 'series',
  title: '저장된 작품',
  knownReleaseIds: [],
  newReleaseIds: [],
  availableReleaseCount: 0,
  schemaVersion: 1,
  createdAt: '',
  updatedAt: '',
  lastCheckedAt: '',
};
function state(records = [work]) {
  return {
    listSubscriptions: vi.fn(async () => records),
    listReleasePreferences: vi.fn(async () => []),
    listLinks: vi.fn(async () => []),
  } as unknown as ExternalSourceLocalState;
}

it('shows local streaming membership without hydration and retires it even when authority is empty', async () => {
  const store = state();
  let result: ReturnType<typeof useCachedSourceLibrary>;
  function Probe({ ready }: { ready: boolean }) {
    result = useCachedSourceLibrary({ state: store, settingsScope: 'account' }, ready);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe ready={false} />);
  });
  expect(result?.subscriptions).toEqual([work]);
  await act(async () => renderer.update(<Probe ready />));
  expect(result).toBeUndefined();
  expect(store.listSubscriptions).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});

it('does not preview trash or works whose downloaded membership still needs reconciliation', async () => {
  const store = state([
    work,
    { ...work, id: 'trashed', deletedAt: '2026-11-01' },
    { ...work, id: 'linked', collectionRemoteId: 'download' },
  ]);
  vi.mocked(store.listLinks).mockResolvedValue([
    {
      source: { connectorId: 'fixture', remoteId: 'chapter' },
      collectionRemoteId: 'download',
      localBookId: 'local',
    } as Awaited<ReturnType<typeof store.listLinks>>[number],
  ]);
  let result: ReturnType<typeof useCachedSourceLibrary>;
  function Probe() {
    result = useCachedSourceLibrary({ state: store }, false);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(result?.subscriptions.map((entry) => entry.id)).toEqual(['stream']);
  await act(async () => renderer.unmount());
});

it('never shows another scope during render or accepts its delayed cache read', async () => {
  const store = state();
  let resolve!: (records: ExternalSourceSubscriptionRecord[]) => void;
  let result: ReturnType<typeof useCachedSourceLibrary>;
  const observed: string[] = [];
  function Probe({ scope }: { scope: string }) {
    result = useCachedSourceLibrary({ state: store, settingsScope: scope }, false);
    if (scope === 'second' && result) observed.push(...result.subscriptions.map((entry) => entry.id));
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe scope="first" />);
  });
  vi.mocked(store.listSubscriptions).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => renderer.update(<Probe scope="second" />));
  expect(result).toBeUndefined();
  expect(observed).toEqual([]);
  await act(async () => renderer.update(<Probe scope="third" />));
  await act(async () => resolve([{ ...work, id: 'late-second' }]));
  expect(result?.settingsScope).toBe('third');
  expect(result?.subscriptions.map((entry) => entry.id)).toEqual(['stream']);
  await act(async () => renderer.unmount());
});
