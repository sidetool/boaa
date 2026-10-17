import { Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChaptersScreenProps } from '../features/chapters/chapters-screen-contract';
import { UiNextWorkspace } from './Workspace';
import { WorkspaceChaptersScreen } from './WorkspaceChaptersScreen';
import { actions, model } from './test-fixtures';
import { setHomeActive } from './home/route';
import { createUiNextNavigation } from './shell/navigation';

const mocks = vi.hoisted(() => ({ next: vi.fn(() => null) }));
vi.mock('./chapters/UiNextChaptersScreen', () => ({ UiNextChaptersScreen: mocks.next }));
vi.mock('./shell/UiNextShell', () => ({ UiNextShell: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => {
  vi.clearAllMocks();
  setHomeActive(false);
});

it.each(['library', 'chapters', 'reader', 'document'])(
  'keeps the current screen for view=%s with original props',
  async (view) => {
    const props = { model: {}, actions: { navigation: { backToLibrary: vi.fn() } } } as unknown as ChaptersScreenProps;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <UiNextWorkspace model={model([])} actions={actions()} view={view}>
            <Suspense fallback={null}>
              <WorkspaceChaptersScreen {...props} />
            </Suspense>
          </UiNextWorkspace>,
        );
      });
      expect(mocks.next).toHaveBeenCalled();
      const received = mocks.next.mock.calls.at(-1) as unknown as [ChaptersScreenProps];
      expect(received[0].model).toBe(props.model);
      expect(received[0].actions).toBe(props.actions);
    } finally {
      act(() => renderer?.unmount());
    }
  },
);

it.each([true, false])('keeps the originating tab in chapter navigation (home=%s)', (home) => {
  expect(createUiNextNavigation({ model: model([]), actions: actions() }, 'chapters', 0, vi.fn(), home).activeTab).toBe(
    home ? 'home' : 'library',
  );
});
