import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { HomeWorkspace } from './HomeWorkspace';
import { HomeDataContext } from './context';
import { UiNextNavigationContext } from '../shell/context';
import { WorkspaceLibraryScreen } from '../Workspace';
import { createUiNextNavigation } from '../shell/navigation';
import { actions, model, novel } from '../test-fixtures';
import { defaultSettings } from '../../repositories/reader-defaults';
import type { HomeAdapterInput } from './model';
import type { UiNextHomeScreenProps } from './contract';

let captured: Omit<HomeAdapterInput, 'navigation'> | undefined;
let screen: UiNextHomeScreenProps | undefined;
function Probe() {
  captured = useContext(HomeDataContext);
  return null;
}
vi.mock('../../features/book-workspace/BookWorkspaceScreens', () => ({ BookWorkspaceScreens: () => <Probe /> }));
vi.mock('./UiNextHomeScreen', () => ({
  UiNextHomeScreen: (props: UiNextHomeScreenProps) => {
    screen = props;
    return null;
  },
}));
it('supplies full data before library filtering and persists configuration through the settings controller', () => {
  const p = { model: model([novel()]), actions: actions() };
  const updateSettings = vi.fn();
  const fullCollection = { ...p.model.collection, visibleBooks: [] };
  const props = {
    homeSettings: { settings: defaultSettings, updateSettings },
    state: {
      selectedNovel: novel({ lastReadChapterIndex: 3 }),
      chapters: [{ id: 'ch3', index: 3, title: '제3화 장면 3' }],
    },
    projection: { libraryCollection: fullCollection },
    externalSources: {
      libraryWorks: [
        {
          id: 'remote',
          title: '작품',
          availableReleaseCount: 10,
          newReleaseIds: ['r1'],
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
          shelfIds: ['s1'],
        },
        {
          id: 'linked',
          title: '연결 작품',
          localBookId: 'novel-1',
          availableReleaseCount: 10,
          newReleaseIds: ['r1'],
          shelfIds: ['s1'],
        },
      ],
      sourceWorkProgress: {
        byNovelId: new Map(),
        bySubscriptionId: new Map([['remote', { readCount: 2, lastReadAt: '2026-01-02' }]]),
      },
    },
    libraryManagement: { memberships: [] },
  } as unknown as Parameters<typeof HomeWorkspace>[0];
  renderToStaticMarkup(<HomeWorkspace {...props} />);
  expect(captured!.books).toHaveLength(1);
  expect(captured!.currentChapters?.get('book:novel-1')).toEqual({ index: 3, title: '제3화 장면 3' });
  expect(captured!.externalWorks.map((work) => work.id)).toEqual(['remote']);
  expect(captured!.externalWorks[0].readReleaseCount).toBe(2);
  expect(captured!.updatedBookIds?.has('novel-1')).toBe(true);
  expect(captured!.memberships).toEqual([
    { bookId: 'external:remote', shelfId: 's1' },
    { bookId: 'novel-1', shelfId: 's1' },
  ]);
  captured!.setConfig([]);
  expect(updateSettings.mock.lastCall![0](defaultSettings).homeRows).toEqual([]);
  const navigation = createUiNextNavigation(p, 'library', 0, vi.fn(), true);
  renderToStaticMarkup(
    <HomeDataContext.Provider value={captured}>
      <UiNextNavigationContext.Provider value={navigation}>
        <WorkspaceLibraryScreen {...p} />
      </UiNextNavigationContext.Provider>
    </HomeDataContext.Provider>,
  );
  expect(screen!.navigation.activeTab).toBe('home');
  expect(screen!.libraryProps).toBeDefined();
  expect(screen!.adapter.rows[0].items).toHaveLength(2);
});
