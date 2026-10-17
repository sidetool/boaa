import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ReaderFeatureHost } from './ReaderFeatureHost';
import { ReaderScreenHandle, type ReaderScreenModel } from '../../features/reader/reader-screen-contract';
import { defaultSettings } from '../../repositories/reader-defaults';
import type { ReaderAddonTabDescriptor } from '../../features/reader/reader-addon-contract';

const state = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  snapshot: { entries: [] as { tab: ReaderAddonTabDescriptor }[] },
  select: vi.fn(),
  renders: 0,
}));
vi.mock('../runtime/RuntimeProvider', () => ({
  useAppRuntime: () => ({
    extensionRuntime: {
      manager: { subscribe: () => () => {}, getRevision: () => 0 },
      trustedExtensions: { getReaderAddonTabs: () => [], getReaderAddon: () => undefined },
    },
  }),
}));
vi.mock('../../extensions/platform/PlatformPluginProvider', () => ({
  useProductPlugins: () => ({ session: undefined }),
}));
vi.mock('../../extensions/ui/ReaderPluginProvider', async () => {
  const { useSyncExternalStore, useLayoutEffect } = await import('react');
  const host = { selectPanel: state.select };
  return {
    useReaderPluginPanelSelection: (tab: string | null) => {
      const snapshot = useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => {
            state.listeners.delete(listener);
          };
        },
        () => state.snapshot,
      );
      useLayoutEffect(() => {
        host.selectPanel(tab);
      }, [tab]);
      return { host, snapshot };
    },
  };
});
vi.mock('../../features/reader/ReaderScreen', () => ({
  default: () => {
    state.renders++;
    return <div>reader</div>;
  },
}));
vi.mock('../../extensions/ui/ReaderPluginPanel', () => ({ ReaderPluginPanel: () => <div>plugin</div> }));
vi.mock('../../ui-next/reader/UiNextReaderTools', async (original) => {
  const module = await original<typeof import('../../ui-next/reader/UiNextReaderTools')>();
  return {
    ...module,
    UiNextReaderTools: ({ tabs, children }: { tabs: readonly ReaderAddonTabDescriptor[]; children: ReactNode }) => (
      <aside>
        {tabs.map((tab) => (
          <span key={tab.id}>{tab.label}</span>
        ))}
        {children}
      </aside>
    ),
  };
});
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  state.snapshot = { entries: [] };
  state.select.mockClear();
  state.renders = 0;
});
const model: ReaderScreenModel = {
  novel: { id: 'book', title: 'Book', totalChapters: 1 },
  chapter: {
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    id: 'chapter',
    novelId: 'book',
    title: 'Chapter',
    index: 0,
    normalizedText: '',
    textHash: 'hash',
    rawStartOffset: 0,
    rawEndOffset: 0,
    characterCount: 0,
    paragraphCount: 0,
  },
  chapters: [],
  settings: defaultSettings,
  bookmarks: [],
  highlights: [],
  addonOpen: true,
  addonTab: 'outline',
  overlays: { settingsOpen: false, syncPanelOpen: false, importOpen: false },
  canRestoreSavedPosition: false,
  statsVisible: false,
  openRequestVersion: 0,
};
it('handles plugin snapshot changes within the Reader subtree and clears selection when leaving', async () => {
  let parentRenders = 0;
  function Parent() {
    parentRenders++;
    return (
      <ReaderFeatureHost
        model={model}
        screenHandle={new ReaderScreenHandle()}
        addonOpen
        addonTab="outline"
        setAddonTab={() => {}}
        closeAddon={() => {}}
        theme="light"
        repository={{ listBookmarks: async () => [], listHighlights: async () => [], listNotes: async () => [] }}
        setBookmarks={() => {}}
        setHighlights={() => {}}
        setNotes={() => {}}
        notify={() => {}}
      >
        Built-in panel
      </ReaderFeatureHost>
    );
  }
  await act(async () => {
    renderer = create(<Parent />);
  });
  expect(state.select).toHaveBeenLastCalledWith('outline');
  const before = state.renders;
  act(() => {
    state.snapshot = { entries: [{ tab: { id: 'synthetic.panel', label: 'Synthetic plugin', icon: 'notes' } }] };
    for (const listener of [...state.listeners]) listener();
  });
  expect(parentRenders).toBe(1);
  expect(state.renders).toBeGreaterThan(before);
  expect(JSON.stringify(renderer!.toJSON())).toContain('Synthetic plugin');
  act(() => renderer!.unmount());
  renderer = undefined;
  expect(state.select).toHaveBeenLastCalledWith(null);
  expect(state.listeners.size).toBe(0);
});
