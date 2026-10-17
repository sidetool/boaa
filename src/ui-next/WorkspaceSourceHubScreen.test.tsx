import { Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceHubScreenProps } from '../features/external-sources/source-hub-contract';
import { UiNextWorkspace } from './Workspace';
import { WorkspaceSourceHubScreen } from './WorkspaceSourceHubScreen';
import { actions, model } from './test-fixtures';
import { setHomeActive } from './home/route';

const mocks = vi.hoisted(() => ({ next: vi.fn(() => null) }));
vi.mock('./source/UiNextSourceHubScreen', () => ({ default: mocks.next }));
vi.mock('./shell/UiNextShell', () => ({ UiNextShell: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => {
  vi.clearAllMocks();
  setHomeActive(false);
});

it.each(['library', 'chapters', 'reader', 'document'])(
  'keeps the current screen for view=%s with original props',
  async (view) => {
    const props = { library: {}, controller: {}, openSourceSettings: vi.fn() } as unknown as SourceHubScreenProps;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <UiNextWorkspace model={model([])} actions={actions()} view={view}>
            <Suspense fallback={null}>
              <WorkspaceSourceHubScreen {...props} />
            </Suspense>
          </UiNextWorkspace>,
        );
      });
      expect(mocks.next).toHaveBeenCalled();
      const received = mocks.next.mock.calls.at(-1) as unknown as [SourceHubScreenProps];
      expect(received[0].controller).toBe(props.controller);
      expect(received[0].openSourceSettings).toBe(props.openSourceSettings);
    } finally {
      act(() => renderer?.unmount());
    }
  },
);
