import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useStreamLibraryContinuity } from './use-stream-library-continuity';
import { recoverStreamLibrary } from './recover-stream-library';
import { episode, fixture, visit } from './source-command-test-fixtures';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
it('adds streamed work metadata', async () => {
  const persist = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    useStreamLibraryContinuity({
      item: episode(),
      subscriptions: [],
      detail: { title: '작품', thumbnailUrl: 'https://example.test/cover' },
      items: [episode()],
      complete: true,
      persist,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Harness />);
  });
  try {
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        navigationRef: 'work',
        baselineComplete: true,
        detail: { title: '작품', thumbnailUrl: 'https://example.test/cover' },
      }),
    );
  } finally {
    act(() => root.unmount());
  }
});
it('recovers previous streams from history and cached metadata without network requests', async () => {
  const f = fixture();
  const saved: ExternalSourceSubscriptionRecord[] = [];
  f.options.state.listSubscriptions = vi.fn(async () => saved);
  f.options.state.saveSubscription = vi.fn(async (work) => {
    saved.push(work);
  });
  vi.mocked(f.options.state.getCachePage).mockResolvedValue({
    items: [episode()],
    detail: { title: '복원 작품', thumbnailUrl: 'https://example.test/cover' },
    completeSeries: true,
  } as never);
  const preferences = [
    { ...visit, readingMode: 'stream' as const, read: true, lastReadAt: '2026-10-01', updatedAt: '2026-10-01' },
  ];
  const result = await recoverStreamLibrary(f.options, [], preferences);
  expect(result[0]).toMatchObject({
    title: '복원 작품',
    availableReleaseCount: 1,
    thumbnailUrl: 'https://example.test/cover',
    createdAt: '2026-10-01',
  });
  expect(f.registry.listExternalSource).not.toHaveBeenCalled();
  expect(await recoverStreamLibrary(f.options, result, preferences)).toEqual(result);
  expect(f.options.state.saveSubscription).toHaveBeenCalledOnce();
  const trashed = { ...result[0], deletedAt: '2026-10-02' };
  expect(await recoverStreamLibrary(f.options, [trashed], preferences)).toEqual([trashed]);
  expect(
    await recoverStreamLibrary(f.options, [], [{ ...preferences[0], read: false, readChangedAt: '2026-10-02' }]),
  ).toEqual([]);
});
