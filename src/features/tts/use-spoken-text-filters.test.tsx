import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useSpokenTextFilters } from './use-spoken-text-filters';
import { resetReaderDbForTests } from '../../storage/reader-database';
let root: ReactTestRenderer;
afterEach(() => {
  if (root) act(() => root.unmount());
});
it('persists filters and publishes the saved list after a StrictMode remount', async () => {
  await resetReaderDbForTests();
  let hook!: ReturnType<typeof useSpokenTextFilters>;
  const changed = vi.fn();
  function Harness() {
    hook = useSpokenTextFilters({ bookId: 'a', onChanged: changed });
    return null;
  }
  await act(async () => {
    root = create(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
  });
  await act(async () => {
    await hook.save({ scope: 'book', kind: 'replace_literal', pattern: 'HP', replacement: '에이치피', enabled: true });
  });
  expect(hook.rules[0].replacement).toBe('에이치피');
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  await act(async () => {
    root = create(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(hook.rules[0].pattern).toBe('HP');
});
it('rejects a stale editor callback after switching books', async () => {
  await resetReaderDbForTests();
  let hook!: ReturnType<typeof useSpokenTextFilters>;
  const changed = vi.fn();
  function Harness({ bookId }: { bookId: string }) {
    hook = useSpokenTextFilters({ bookId, onChanged: changed });
    return null;
  }
  await act(async () => {
    root = create(<Harness bookId="a" />);
  });
  const oldSave = hook.save;
  await act(async () => {
    root.update(<Harness bookId="b" />);
  });
  await expect(
    oldSave({ scope: 'book', kind: 'replace_literal', pattern: 'x', replacement: 'y', enabled: true }),
  ).rejects.toThrow('책이 바뀌었어요');
  expect(hook.rules).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});

it('retries a failed read for the same book and clears the error without editing filters', async () => {
  await resetReaderDbForTests();
  const { openReaderDb } = await import('../../storage/reader-database');
  const openDb = vi.fn(openReaderDb).mockRejectedValueOnce(new Error('temporary storage failure'));
  const onChanged = vi.fn();
  let hook!: ReturnType<typeof useSpokenTextFilters>;
  function Harness() {
    hook = useSpokenTextFilters({ bookId: 'b', openDb, onChanged });
    return null;
  }
  await act(async () => {
    root = create(<Harness />);
  });
  expect(hook.ready).toBe(false);
  expect(hook.error).toBeTruthy();
  await act(async () => {
    await hook.retry();
  });
  expect(hook.ready).toBe(true);
  expect(hook.error).toBeUndefined();
  expect(onChanged).not.toHaveBeenCalled();
});

it('ignores a late filter read failure after switching to a ready book', async () => {
  await resetReaderDbForTests();
  const { openReaderDb } = await import('../../storage/reader-database');
  let reject!: (error: Error) => void;
  const openDb = vi.fn(openReaderDb).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const onError = vi.fn();
  let hook!: ReturnType<typeof useSpokenTextFilters>;
  function Harness({ bookId }: { bookId: string }) {
    hook = useSpokenTextFilters({ bookId, openDb, onChanged: () => {}, onError });
    return null;
  }
  await act(async () => {
    root = create(<Harness bookId="first" />);
  });
  await act(async () => {
    root.update(<Harness bookId="second" />);
  });
  await vi.waitFor(() => expect(hook.ready).toBe(true));
  await act(async () => {
    reject(new Error('old read failed'));
  });
  expect(hook.ready).toBe(true);
  expect(hook.error).toBeUndefined();
  expect(onError).not.toHaveBeenCalled();
});
