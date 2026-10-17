import { expect, it, vi } from 'vitest';
import { ownedSourceStreamPort } from './source-owned-stream-port';
import { isTextStream } from '../../external-sources/source-text-stream';
import { deferred } from './source-command-test-fixtures';
import type { SourceStreamSession } from '../../external-sources/source-stream';
it('forwards prototype page count, invalidation and close with their original receiver', async () => {
  class Session {
    pages = 2;
    invalidated: number[] = [];
    closed = false;
    get pageCount() {
      return this.pages;
    }
    invalidatePage(index: number) {
      this.invalidated.push(index);
    }
    async loadPage() {
      return new Blob(['synthetic']);
    }
    close() {
      this.closed = true;
    }
  }
  const original = new Session();
  const port = ownedSourceStreamPort({ open: async () => original }, () => {});
  if (isTextStream(port)) throw Error('image port expected');
  const session = await port.open('one', new AbortController().signal);
  expect(session.pageCount).toBe(2);
  original.pages = 3;
  expect(session.pageCount).toBe(3);
  session.invalidatePage!(1);
  expect(original.invalidated).toEqual([1]);
  session.close();
  expect(original.closed).toBe(true);
});
it('closes an image session that resolves after its owner was replaced', async () => {
  const pending = deferred<SourceStreamSession>();
  let active = true;
  const session = { pageCount: 1, loadPage: vi.fn(), close: vi.fn() };
  const port = ownedSourceStreamPort({ open: () => pending.promise }, () => {
    if (!active) throw new DOMException('stale', 'AbortError');
  });
  const result = port.open('one', new AbortController().signal);
  active = false;
  pending.resolve(session);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.close).toHaveBeenCalledOnce();
});
