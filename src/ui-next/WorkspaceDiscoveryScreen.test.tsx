import { Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiscoveryScreenProps } from '../features/discovery/useDiscoveryScreenState';
import { UiNextWorkspace } from './Workspace';
import { WorkspaceDiscoveryScreen } from './WorkspaceDiscoveryScreen';
import { actions, model } from './test-fixtures';
import { setHomeActive } from './home/route';

const mocks = vi.hoisted(() => ({ next: vi.fn(() => null) }));
vi.mock('./discovery/UiNextDiscoveryScreen', () => ({ default: mocks.next }));
vi.mock('./shell/UiNextShell', () => ({ UiNextShell: ({ children }: { children: React.ReactNode }) => children }));
afterEach(() => {
  vi.clearAllMocks();
  setHomeActive(false);
});

it.each(['library', 'chapters', 'reader', 'document'])(
  'keeps the current screen for view=%s with original props',
  async (view) => {
    const props = { library: {}, discovery: {}, sources: {}, open: vi.fn() } as unknown as DiscoveryScreenProps;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <UiNextWorkspace model={model([])} actions={actions()} view={view}>
            <Suspense fallback={null}>
              <WorkspaceDiscoveryScreen {...props} />
            </Suspense>
          </UiNextWorkspace>,
        );
      });
      expect(mocks.next).toHaveBeenCalled();
      const received = mocks.next.mock.calls.at(-1) as unknown as [DiscoveryScreenProps];
      expect(received[0].discovery).toBe(props.discovery);
      expect(received[0].open).toBe(props.open);
    } finally {
      act(() => renderer?.unmount());
    }
  },
);
