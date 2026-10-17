import { Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReaderSettingsPanelProps } from '../features/reader-settings/settings-panel-contract';
const mocks = vi.hoisted(() => ({ next: vi.fn(() => null) }));
vi.mock('./settings/UiNextSettingsPanel', () => ({ default: mocks.next }));
afterEach(() => vi.clearAllMocks());
it('lazy-loads settings with unchanged contract', async () => {
  vi.resetModules();

  const { default: Panel } = await import('./SettingsPanel');
  const props = { controller: {}, initialTab: 'downloads' } as ReaderSettingsPanelProps;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <Suspense fallback={null}>
          <Panel {...props} />
        </Suspense>,
      );
    });
    const component = mocks.next;
    expect(component).toHaveBeenCalled();
    const received = component.mock.calls.at(-1) as unknown as [ReaderSettingsPanelProps];
    expect(received[0].controller).toBe(props.controller);
    expect(received[0].initialTab).toBe('downloads');
  } finally {
    act(() => renderer?.unmount());
  }
});
