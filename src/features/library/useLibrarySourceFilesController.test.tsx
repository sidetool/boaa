import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { testNovel, testWorkspaceState } from '../book-workspace/book-workspace-test-fixtures';
import type { LibrarySourceFilesController, LibrarySourceFilesPorts } from './library-source-files-controller';
import { useLibrarySourceFilesController } from './useLibrarySourceFilesController';

it('reuses the session across notification preference changes, fences account ABA, and deactivates on unmount', async () => {
  const runtime = {};
  const ports: LibrarySourceFilesPorts = {
    browser: false,
    reader: { getNovel: vi.fn() },
    documentIo: { saveDocument: vi.fn() },
    workspace: { getSnapshot: () => testWorkspaceState(), subscribe: () => () => undefined, openNovel: vi.fn() },
    refresh: vi.fn(),
    notify: vi.fn(),
  };
  let current!: LibrarySourceFilesController;
  function Probe({ account, notify = ports.notify }: { account: string; notify?: LibrarySourceFilesPorts['notify'] }) {
    current = useLibrarySourceFilesController({ ...ports, notify }, { runtime, account, settingsScope: 'scope' });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe account="one" />);
  });
  const first = current;
  const nextNotify = vi.fn();
  act(() => {
    renderer.update(<Probe account="one" notify={nextNotify} />);
  });
  expect(current).toBe(first);
  await current.exportLegacy(testNovel());
  expect(nextNotify).toHaveBeenCalledOnce();
  act(() => {
    renderer.update(<Probe account="two" />);
  });
  act(() => {
    renderer.update(<Probe account="one" />);
  });
  expect(current).not.toBe(first);
  await first.exportLegacy(testNovel());
  expect(ports.notify).not.toHaveBeenCalled();
  act(() => {
    renderer.unmount();
  });
  await current.exportLegacy(testNovel());
  expect(ports.notify).not.toHaveBeenCalled();
});
