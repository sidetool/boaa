import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { flushReaderBoundary } from '../reader/use-reader-lifecycle-flush';
import { useFixedDocumentProgress } from './use-fixed-document-progress';

describe('fixed document progress persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('flushes a pending read before back navigation and does not save it twice on unmount', async () => {
    const save = vi.fn();
    let flush!: () => Promise<void>;
    let page = 0;
    let novel = testNovel({ format: 'image_archive' });
    const chapters = [testChapter(1), testChapter(2)];
    function Harness() {
      flush = useFixedDocumentProgress(page, chapters[page], novel, save);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    page = 1;
    await act(async () => {
      renderer.update(<Harness />);
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      await flush();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(1, chapters[1], novel);
    novel = { ...novel, lastReadChapterId: chapters[1]!.id };
    await act(async () => {
      renderer.update(<Harness />);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      renderer.unmount();
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it('serializes saves and captures the original book before an in-flight save finishes', async () => {
    let finishFirst!: () => void;
    const save = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const original = testNovel({ format: 'image_archive' });
    let novel = original;
    let page = 0;
    function Harness() {
      useFixedDocumentProgress(page, testChapter(page + 1), novel, save);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await vi.advanceTimersByTimeAsync(350);
    });
    page = 5;
    await act(async () => {
      renderer.update(<Harness />);
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(save).toHaveBeenCalledOnce();
    novel = testNovel({ id: 'other-book', format: 'image_archive' });
    await act(async () => {
      renderer.update(<Harness />);
    });
    await act(async () => {
      finishFirst();
    });
    expect(save.mock.calls[1]?.[2]).toBe(original);
    await act(async () => {
      renderer.unmount();
    });
    expect(save.mock.calls[2]?.[2]).toBe(novel);
  });
  it('does not mark loading or failed pages read and participates in browser back flush', async () => {
    const save = vi.fn();
    let ready = false;
    function Harness() {
      useFixedDocumentProgress(0, testChapter(1), testNovel(), save, { ready });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await vi.advanceTimersByTimeAsync(500);
    await flushReaderBoundary();
    expect(save).not.toHaveBeenCalled();
    ready = true;
    await act(async () => {
      renderer.update(<Harness />);
    });
    await flushReaderBoundary();
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      renderer.unmount();
    });
  });
  it('orders writes across unmount and remount with the same repository owner', async () => {
    const owner = {};
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    function Harness({ page }: { page: number }) {
      useFixedDocumentProgress(page, testChapter(page + 1), testNovel(), save, { owner });
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness page={0} />);
    });
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      renderer = create(<Harness page={4} />);
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await flushReaderBoundary();
    expect(save.mock.calls.map((call) => call[0])).toEqual([0, 4]);
    await act(async () => {
      renderer.unmount();
    });
  });
});
