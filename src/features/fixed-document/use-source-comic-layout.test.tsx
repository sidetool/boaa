import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useSourceComicLayout } from './use-source-comic-layout';
import { loadSourceComicProfile } from './source-comic-default';
import { DEFAULT_COMIC_READING_PROFILE } from './comic-layout';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
vi.mock('./source-comic-default', () => ({ loadSourceComicProfile: vi.fn() }));
let root: ReactTestRenderer;
afterEach(() => {
  act(() => root?.unmount());
  vi.resetAllMocks();
});
it('keeps images gated until the profile is applied and synchronously gates a new document', async () => {
  let finish!: (profile: typeof DEFAULT_COMIC_READING_PROFILE) => void;
  vi.mocked(loadSourceComicProfile).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const apply = vi.fn(),
    begin = vi.fn();
  let state!: ReturnType<typeof useSourceComicLayout>;
  const document = {
    novel: testNovel({ format: 'image_archive' }),
    chapters: [],
    repository: {},
    assets: {},
  } as unknown as Parameters<typeof useSourceComicLayout>[0]['document'];
  const ready: boolean[] = [];
  function Harness({ id = 'one' }) {
    state = useSourceComicLayout({
      document: { ...document, novel: { ...document.novel, id } },
      profiles: {} as never,
      profileKey: 'work',
      detect: true,
      editVersion: { current: 0 },
      apply,
      begin,
    });
    ready.push(state.layoutReady);
    return null;
  }
  await act(async () => {
    root = create(<Harness />);
  });
  expect(state.layoutReady).toBe(false);
  expect(apply).not.toHaveBeenCalled();
  await act(async () => {
    finish({ ...DEFAULT_COMIC_READING_PROFILE, mode: 'vertical', fit: 'width' });
  });
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'vertical', fit: 'width' }));
  expect(state.layoutReady).toBe(true);
  ready.length = 0;
  await act(async () => root.update(<Harness id="two" />));
  expect(ready[0]).toBe(false);
});
it('exposes probe failures for retry and does not overwrite edits made during probing', async () => {
  const editVersion = { current: 0 },
    apply = vi.fn();
  vi.mocked(loadSourceComicProfile)
    .mockRejectedValueOnce(new Error('probe failed'))
    .mockImplementation(async () => {
      editVersion.current++;
      return DEFAULT_COMIC_READING_PROFILE;
    });
  let state!: ReturnType<typeof useSourceComicLayout>;
  function Harness() {
    state = useSourceComicLayout({
      document: { novel: testNovel({ format: 'image_archive' }) } as never,
      profiles: {} as never,
      profileKey: 'work',
      detect: true,
      editVersion,
      apply,
      begin: vi.fn(),
    });
    return null;
  }
  await act(async () => {
    root = create(<Harness />);
  });
  expect(state.layoutReady).toBe(false);
  expect(state.error).toBeInstanceOf(Error);
  await act(async () => state.retry());
  expect(state.layoutReady).toBe(true);
  expect(state.error).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
});
