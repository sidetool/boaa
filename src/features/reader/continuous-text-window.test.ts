import { describe, expect, it, vi } from 'vitest';
import { Virtualizer } from '@tanstack/react-virtual';
import type { Chapter, Paragraph } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import { ContinuousTextWindow, type ContinuousTextChapter } from './continuous-text-window';

function entry(id: string, count = 3): ContinuousTextChapter {
  const chapter = { id, novelId: 'synthetic', paragraphCount: count, textHash: id } as Chapter;
  const paragraphs = Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `${id}-p${index}`,
        novelId: 'synthetic',
        chapterId: id,
        index: index + 1,
        text: `합성 문단 ${index}`,
        textHash: `${id}:${index}`,
        startOffsetInChapter: 0,
        endOffsetInChapter: 8,
      }) satisfies Paragraph,
  );
  return {
    chapter,
    repository: {
      getParagraphPage: vi.fn(async (_id, page) => ({
        id: `${id}:${page}`,
        novelId: 'synthetic',
        chapterId: id,
        pageIndex: page,
        startParagraphIndex: page * PARAGRAPHS_PER_PAGE + 1,
        endParagraphIndex: Math.min(count, (page + 1) * PARAGRAPHS_PER_PAGE),
        paragraphs: paragraphs.slice(page * PARAGRAPHS_PER_PAGE, (page + 1) * PARAGRAPHS_PER_PAGE),
        textHash: id,
      })),
    } as unknown as ReaderBodyRepository,
  };
}

describe('continuous text source coordinates', () => {
  it('retains all-row measurements across page loads and refreshes keys only on structural changes', async () => {
    const first = entry('large', 10000),
      next = entry('next');
    const window = new ContinuousTextWindow(first, { neighbor: async () => next }, 'revision', vi.fn());
    const key = vi.spyOn(window, 'key');
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count: window.count,
      getItemKey: window.getItemKey,
      getScrollElement: () => null,
      estimateSize: () => 80,
      observeElementRect: () => undefined,
      observeElementOffset: () => undefined,
      scrollToFn: vi.fn(),
    });
    virtualizer.getTotalSize();
    const original = window.getItemKey;
    key.mockClear();
    await window.loadIndexes([0]);
    virtualizer.setOptions({ ...virtualizer.options, getItemKey: window.getItemKey });
    virtualizer.getTotalSize();
    expect(window.getItemKey).toBe(original);
    expect(key).not.toHaveBeenCalled();
    await window.prepare(-1);
    expect(window.getItemKey).not.toBe(original);
    virtualizer.setOptions({ ...virtualizer.options, count: window.count, getItemKey: window.getItemKey });
    virtualizer.getTotalSize();
    expect(virtualizer.measurementsCache[0].key).toBe('next:0');
    window.dispose();
  });

  it('prepares without visits and preserves source identity through prepend and trim', async () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(`chapter-${index}`));
    const observed = vi.fn();
    const window = new ContinuousTextWindow(
      entries[1],
      {
        observed,
        neighbor: async (id, direction) => entries[entries.findIndex((entry) => entry.chapter.id === id) + direction],
      },
      'revision',
      vi.fn(),
    );
    await window.loadIndexes([0]);
    const before = window.paragraphAt(0)!;
    await window.prepare(1);
    await window.prepare(-1);
    const index = window.index(entries[1].chapter.id, 0)!;
    const after = window.paragraphAt(index)!;
    expect(after.id).toBe(before.id);
    expect(window.original(after).index).toBe(1);
    expect(observed).not.toHaveBeenCalled();
    for (let index = 0; index < 6; index++) await window.prepare(1);
    window.prune([window.index('chapter-7', 0)!]);
    await Promise.resolve();
    expect(window.entries.length).toBeLessThanOrEqual(5);
    expect(window.index('chapter-7', 0)).toBeDefined();
    await window.prepare(-1);
    expect(window.status(-1)).not.toBe('end');
    window.dispose();
  });

  it('only explicit retry clears the failed prepared edge', async () => {
    const first = entry('a'),
      next = entry('b');
    const read = vi.mocked(next.repository.getParagraphPage);
    read.mockRejectedValueOnce(new Error('Synthetic offline'));
    const window = new ContinuousTextWindow(first, { neighbor: async () => next }, 'revision', vi.fn());
    await window.prepare(1);
    expect(window.status(1)).toBe('error');
    await window.prepare(1);
    expect(read).toHaveBeenCalledTimes(1);
    await window.prepare(1, true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(window.last.id).toBe('b');
    window.dispose();
  });

  it('prunes projected objects with the underlying pages', async () => {
    const initial = entry('long', 2400);
    const window = new ContinuousTextWindow(initial, { neighbor: async () => undefined }, 'revision', vi.fn());
    for (let at = 0; at < 2400; at += PARAGRAPHS_PER_PAGE) {
      const indexes = Array.from({ length: PARAGRAPHS_PER_PAGE }, (_, index) => at + index);
      await window.loadIndexes(indexes);
      indexes.forEach((index) => window.paragraphAt(index));
      window.prune([at]);
    }
    expect(window.paragraphById('long-p0')).toBeUndefined();
    expect((window as unknown as { projected: Map<string, unknown> }).projected.size).toBeLessThanOrEqual(
      PARAGRAPHS_PER_PAGE * 3,
    );
    window.dispose();
  });

  it('does not append or publish after its lifetime ends', async () => {
    let release!: (entry: ContinuousTextChapter) => void;
    const notify = vi.fn();
    const window = new ContinuousTextWindow(
      entry('a'),
      {
        neighbor: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      'revision',
      notify,
    );
    const pending = window.prepare(1);
    await Promise.resolve();
    window.dispose();
    notify.mockClear();
    release(entry('b'));
    await pending;
    expect(window.entries).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
