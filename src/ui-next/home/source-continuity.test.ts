import { afterEach, expect, it, vi } from 'vitest';
import { externalItemKeyId } from '../../external-sources/contracts';
import { saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import { homeSourceContinuity } from './source-continuity';
import { createUiNextHomeAdapter } from './model';
import { actions, model, novel } from '../test-fixtures';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import {
  normalizeReleasePreference,
  validReleasePreference,
  releasePreferenceId,
} from '../../external-sources/source-user-state';

afterEach(() => vi.unstubAllGlobals());
it('projects streamed comics into continue-reading with episode data, progress, cover, source and resume action', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const source = { connectorId: 'fixture.comic', remoteId: 'episode' };
  const lastReadAt = new Date().toISOString();
  const work = {
    id: 'work',
    connectorId: source.connectorId,
    collectionRemoteId: 'collection',
    title: '작품',
    thumbnailUrl: 'https://example.test/cover',
    sourceLabel: '소스',
    availableReleaseCount: 1,
    readReleaseCount: 1,
    newReleaseCount: 0,
    addedAt: lastReadAt,
    updatedAt: lastReadAt,
    lastReadAt,
  };
  const visit = {
    id: releasePreferenceId(source),
    kind: 'releasePreference' as const,
    source,
    collectionRemoteId: 'collection',
    lastReadAt,
    updatedAt: lastReadAt,
    readingMode: 'stream' as const,
    lastReadRelease: { title: '1화', number: 1 },
  };
  expect(validReleasePreference(visit)).toBe(true);
  expect(validReleasePreference({ ...visit, lastReadRelease: null })).toBe(false);
  expect(validReleasePreference({ ...visit, lastReadRelease: { title: '1화', number: -1 } })).toBe(false);
  expect(normalizeReleasePreference(visit).lastReadRelease).toEqual(visit.lastReadRelease);
  saveSourceStreamPosition(JSON.stringify(['scope', externalItemKeyId(source)]), {
    page: 2,
    count: 10,
    fraction: 0,
    ratio: 1,
  });
  const history = homeSourceContinuity({
    libraryWorks: [work],
    sourceHistoryScope: 'scope',
    sourceVisits: new Map([[externalItemKeyId({ ...source, remoteId: 'collection' }), visit]]),
  } as unknown as ExternalSourceController);
  const p = { model: model([]), actions: actions() };
  p.actions.books.continueExternal = vi.fn();
  const home = createUiNextHomeAdapter(p, {
    books: [],
    externalWorks: [work],
    sourcePositions: history.positions,
    currentChapters: history.chapters,
    memberships: [],
    navigation: { openLibraryRoot: vi.fn() },
    setConfig: vi.fn(),
  });
  expect(home.hero).toHaveLength(1);
  expect(home.hero[0]).toMatchObject({
    reason: 'continue',
    item: { work: { thumbnailUrl: work.thumbnailUrl } },
    sourcePosition: { episodeNumber: 1, episodeTitle: '1화', progress: 0.3, page: 2, count: 10 },
  });
  await home.hero[0].resume();
  expect(p.actions.books.continueExternal).toHaveBeenCalledWith('work');
  await home.hero[0].openDetail();
  expect(p.actions.books.openExternal).toHaveBeenCalledWith('work');
});
it('saved source text books use the existing local book hero path', () => {
  const p = {
    model: model([novel({ lastReadAt: new Date().toISOString(), lastReadProgress: 0.2 })]),
    actions: actions(),
  };
  const home = createUiNextHomeAdapter(p, {
    books: p.model.collection.visibleBooks,
    externalWorks: [],
    memberships: [],
    setConfig: vi.fn(),
    navigation: { openLibraryRoot: vi.fn() },
  });
  expect(home.hero[0].item.kind).toBe('book');
  home.hero[0].resume();
  expect(p.actions.books.continueReading).toHaveBeenCalledWith(p.model.collection.visibleBooks[0].novel);
});
