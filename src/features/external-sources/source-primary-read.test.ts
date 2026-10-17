import { expect, it, vi } from 'vitest';
import { sourceEpisodeNumber, sourcePrimaryRead } from './source-primary-read';
import { episode, visit } from './source-command-test-fixtures';
import type { ExternalSourceController } from './external-source-controller-contract';
it.each([
  ['1화', 0, undefined, 1],
  ['12화', 11, undefined, 12],
  ['12화', 8, undefined, 8],
  ['특별편', undefined, 7, 7],
  ['특별편', 0, 0, 1],
  ['제3화 장면 3', 2, undefined, 3],
] as const)('resolves %s with chapterNumber %s', (title, chapterNumber, sourceOrder, expected) => {
  expect(sourceEpisodeNumber({ title, release: { title, chapterNumber, sourceOrder } })).toBe(expected);
});
function controller() {
  return {
    items: [episode('two'), episode()],
    importAndOpen: vi.fn(),
    openImported: vi.fn(),
    resumeCurrentWork: vi.fn(),
  } as unknown as ExternalSourceController;
}
it('offers the first source episode on first visit, and honors descending sort', async () => {
  const c = controller();
  const first = sourcePrimaryRead(c)!;
  expect(first).toMatchObject({ kind: 'first', episodeNumber: 1, item: { key: { remoteId: 'one' } }, busy: false });
  expect(first).not.toHaveProperty('label');
  await first.run();
  expect(c.importAndOpen).toHaveBeenCalledWith(c.items[1]);
  expect(sourcePrimaryRead(c, 'desc')?.item.key.remoteId).toBe('two');
});
it('prefers source history over sort and resumes even when the visited episode is not on this page', async () => {
  const c = {
    ...controller(),
    currentWorkVisit: {
      ...visit,
      lastReadAt: '2026-01-01',
      source: { ...visit.source, remoteId: 'missing' },
      lastReadRelease: { title: '5화', number: 5 },
    },
    canResumeCurrentWork: true,
  };
  const primary = sourcePrimaryRead(c)!;
  expect(primary).toMatchObject({ kind: 'continue', episodeTitle: '5화', episodeNumber: 5 });
  await primary.run();
  expect(c.resumeCurrentWork).toHaveBeenCalledOnce();
});
it('opens saved episodes normally and blocks duplicate opens while saving', async () => {
  const c = controller();
  const saved = {
    ...episode(),
    readingState: 'current' as const,
    localBookId: 'book',
    importState: 'imported' as const,
  };
  await sourcePrimaryRead({ ...c, items: [saved] })!.run();
  expect(c.openImported).toHaveBeenCalledWith(saved);
  const busy = sourcePrimaryRead({ ...c, openingItemKey: 'pending' })!;
  expect(busy.busy).toBe(true);
  await busy.run();
  expect(c.importAndOpen).not.toHaveBeenCalled();
});
