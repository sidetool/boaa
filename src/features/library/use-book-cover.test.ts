import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { useBookCover } from './use-book-cover';

describe('book artwork hook', () => {
  it('passes a revision, deduplicates, and returns a memory hit on the first remount render', async () => {
    const getActiveCover = vi.fn(async () => ({ blob: new Blob(['image'], { type: 'image/png' }) }));
    const repository = { getActiveCover } as unknown as BookAssetRepository;
    const novel = { id: 'book', coverAssetId: 'asset', coverContentHash: 'sha256:first' } as Novel;
    const frames: Array<string | undefined> = [];
    function Probe({ book = novel }: { book?: Novel }) {
      frames.push(useBookCover(book, repository));
      return null;
    }
    let a!: ReactTestRenderer, b!: ReactTestRenderer;
    await act(async () => {
      a = create(createElement(Probe));
      b = create(createElement(Probe));
    });
    expect(getActiveCover).toHaveBeenCalledTimes(1);
    expect(getActiveCover).toHaveBeenCalledWith('book', 'asset:sha256:first');
    const url = frames[frames.length - 1];
    expect(url).toMatch(/^blob:/);
    await act(async () => {
      a.unmount();
      b.unmount();
    });
    frames.length = 0;
    await act(async () => {
      a = create(createElement(Probe));
    });
    expect(frames[0]).toBe(url);
    expect(getActiveCover).toHaveBeenCalledTimes(1);
    frames.length = 0;
    await act(async () => {
      a.update(createElement(Probe, { book: { ...novel, coverAssetId: 'new', coverContentHash: 'sha256:next' } }));
    });
    expect(frames[0]).toBeUndefined();
    expect(getActiveCover).toHaveBeenLastCalledWith('book', 'new:sha256:next');
    await act(async () => a.unmount());
  });
});
