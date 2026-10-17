import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import { ParagraphPageCache } from './paragraph-page-cache';

const page = (index: number) =>
  ({ paragraphs: [{ id: `p${index}`, index: index * 120 + 1, text: 'Body' }] }) as ParagraphPage;
afterEach(() => vi.useRealTimers());
describe('scroll source page prefetch', () => {
  it('removes the 180ms source-boundary wait when the next page is warmed while reading', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(
      (_chapter: string, index: number) =>
        new Promise<ParagraphPage>((resolve) => setTimeout(() => resolve(page(index)), 180)),
    );
    const cold = new ParagraphPageCache(120, () => undefined);
    const start = Date.now();
    const coldEntry = cold.loadIndexes('c', [120], loader);
    await vi.advanceTimersByTimeAsync(180);
    await coldEntry;
    expect(Date.now() - start).toBe(180);
    const warm = new ParagraphPageCache(120, () => undefined);
    warm.prefetchIndexes('c', [120], loader);
    await vi.advanceTimersByTimeAsync(180);
    const warmedAt = Date.now();
    await warm.loadIndexes('c', [120], loader);
    expect(Date.now() - warmedAt).toBe(0);
    expect(loader).toHaveBeenCalledTimes(2); // one request per cache, no extra foreground request
  });

  it('replaces stale queued pages, bounds speculation to one and lets foreground bypass it', async () => {
    const resolvers = new Map<number, (page: ParagraphPage) => void>();
    const loader = vi.fn(
      (_chapter: string, index: number) => new Promise<ParagraphPage>((resolve) => resolvers.set(index, resolve)),
    );
    const cache = new ParagraphPageCache(120, () => undefined);
    cache.prefetchIndexes('c', [120, 0], loader);
    cache.prefetchIndexes('c', [600, 360], loader);
    const foreground = cache.loadIndexes('c', [480], loader);
    expect(loader.mock.calls.map((call) => call[1])).toEqual([1, 4]);
    resolvers.get(4)!(page(4));
    await foreground;
    resolvers.get(1)!(page(1));
    await vi.waitFor(() => expect(loader.mock.calls.map((call) => call[1])).toEqual([1, 4, 5]));
    cache.dispose();
    resolvers.get(5)!(page(5));
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('keeps speculative failure retryable but reports a failure to a joined foreground reader', async () => {
    const cache = new ParagraphPageCache(120, () => undefined);
    const loader = vi.fn().mockResolvedValue(undefined);
    cache.prefetchIndexes('c', [120], loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.isPageFailed(1)).toBe(false);
    let reject!: (reason: Error) => void;
    loader.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    cache.prefetchIndexes('c', [120], loader);
    const foreground = cache.loadIndexes('c', [120], loader);
    reject(new Error('offline'));
    await foreground;
    expect(cache.isPageFailed(1)).toBe(true);
  });
});
