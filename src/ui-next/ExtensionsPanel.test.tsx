import { Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { InstalledExtensionsPanelProps } from '../features/extensions/installed-extensions-contract';

type Props = InstalledExtensionsPanelProps;
const mocks = vi.hoisted(() => ({
  next: vi.fn((props: Props) => <p>next extensions {props.updatesRequest}</p>),
}));
vi.mock('./settings/UiNextExtensionsPanel', () => ({ UiNextExtensionsPanel: mocks.next }));
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
});

it('lazy-loads the extension panel with unchanged props', async () => {
  vi.resetModules();

  const { default: Panel } = await import('./ExtensionsPanel');
  // The dispatcher only forwards this contract; the screen tests exercise the manager itself.
  const manager: Props['manager'] = {
    target: 'device',
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({ available: true, revision: 1, packages: [], sources: [], errors: [] })),
    refresh: vi.fn(),
    inspect: vi.fn(),
    install: vi.fn(),
    change: vi.fn(),
    releaseCovers: vi.fn(),
    getExternalSources: vi.fn(() => []),
    getExternalSourceStatus: vi.fn(),
    connectExternalSource: vi.fn(),
    disconnectExternalSource: vi.fn(),
    listExternalSource: vi.fn(),
    downloadExternalSource: vi.fn(),
  };
  const props: Props = { manager, sourceTarget: 'device', onSourceTargetChange: vi.fn(), updatesRequest: 3 };
  await act(async () => {
    renderer = create(
      <Suspense fallback={<p>loading</p>}>
        <Panel {...props} />
      </Suspense>,
    );
  });
  expect(renderer!.root.findByType('p').children.join('')).toBe('next extensions 3');
  const chosen = mocks.next;
  expect(chosen).toHaveBeenCalled();
  const received = chosen.mock.calls.at(-1)![0];
  expect(received.manager).toBe(props.manager);
  expect(received.sourceTarget).toBe('device');
  expect(received.onSourceTargetChange).toBe(props.onSourceTargetChange);
  expect(received.updatesRequest).toBe(3);
});
