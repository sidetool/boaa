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
