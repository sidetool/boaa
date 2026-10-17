import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { usePluginAnnotationRefresh, type PluginAnnotationRefreshPorts } from './use-plugin-annotation-refresh';
import type { Bookmark } from '../../domain/types';
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
});
function deferred() {
  let resolve!: (rows: Bookmark[]) => void;
  const promise = new Promise<Bookmark[]>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
function harness() {
  const ports: PluginAnnotationRefreshPorts = {
    repository: {
      listBookmarks: vi.fn(async () => []),
      listHighlights: vi.fn(async () => []),
      listNotes: vi.fn(async () => []),
    },
    setBookmarks: vi.fn(),
    setHighlights: vi.fn(),
    setNotes: vi.fn(),
    notify: vi.fn(),
  };
  let refresh!: () => void;
  function Harness({ book, revision }: { book: string; revision: string }) {
    refresh = usePluginAnnotationRefresh(book, revision, ports);
    return null;
  }
  act(() => {
    renderer = create(<Harness book="a" revision="v1" />);
  });
  return {
    ports,
    get refresh() {
      return refresh;
    },
    update(book: string, revision = 'v1') {
      act(() => renderer!.update(<Harness book={book} revision={revision} />));
    },
  };
}
it('publishes only the newest reload and keeps all annotation collections together', async () => {
  const h = harness();
  const slow = deferred();
  vi.mocked(h.ports.repository.listBookmarks).mockImplementationOnce(() => slow.promise);
  h.refresh();
  h.refresh();
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.setBookmarks).toHaveBeenCalledTimes(1);
  slow.resolve([]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.setBookmarks).toHaveBeenCalledTimes(1);
  expect(h.ports.setHighlights).toHaveBeenCalledTimes(1);
  expect(h.ports.setNotes).toHaveBeenCalledTimes(1);
});
it.each(['book', 'revision', 'unmount'])('ignores a reload after %s replacement', async (change) => {
  const h = harness();
  const slow = deferred();
  vi.mocked(h.ports.repository.listBookmarks).mockImplementationOnce(() => slow.promise);
  h.refresh();
  if (change === 'unmount') {
    act(() => renderer!.unmount());
    renderer = undefined;
  } else h.update(change === 'book' ? 'b' : 'a', change === 'revision' ? 'v2' : 'v1');
  slow.resolve([]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.setBookmarks).not.toHaveBeenCalled();
  expect(h.ports.notify).not.toHaveBeenCalled();
});
it('rejects a callback retained by the old Reader after replacement', async () => {
  const h = harness();
  const old = h.refresh;
  h.update('b');
  old();
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.repository.listBookmarks).not.toHaveBeenCalled();
  h.refresh();
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.repository.listBookmarks).toHaveBeenCalledWith('b');
});
it('reports a current reload failure once without publishing partial annotations', async () => {
  const h = harness();
  vi.mocked(h.ports.repository.listNotes).mockRejectedValue(new Error('offline'));
  h.refresh();
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.notify).toHaveBeenCalledTimes(1);
  expect(h.ports.setBookmarks).not.toHaveBeenCalled();
  expect(h.ports.setHighlights).not.toHaveBeenCalled();
});
it('suppresses failure feedback from a Reader that has been replaced', async () => {
  const h = harness();
  let reject!: (error: Error) => void;
  vi.mocked(h.ports.repository.listNotes).mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  h.refresh();
  h.update('b');
  reject(new Error('offline'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(h.ports.notify).not.toHaveBeenCalled();
});
