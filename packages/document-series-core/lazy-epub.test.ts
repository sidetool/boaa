import { describe, expect, it, vi } from 'vitest';
import { inspectDocumentSeriesSource } from './index';

const loadEpub = vi.hoisted(() => vi.fn());
vi.mock('@boaa/epub-core', () => {
  loadEpub();
  throw new Error('Optional EPUB parser could not be loaded');
});

describe('optional document series parser loading', () => {
  it('keeps TXT inspection available when the EPUB parser cannot load and rejects an EPUB request', async () => {
    const text = await inspectDocumentSeriesSource({
      fileName: 'chapter.txt',
      blob: new Blob(['A chapter paragraph.']),
      encoding: 'utf-8',
    });
    expect(text.format).toBe('txt');
    expect(text.chapters).toHaveLength(1);
    expect(loadEpub).not.toHaveBeenCalled();

    await expect(
      inspectDocumentSeriesSource({ fileName: 'chapter.epub', blob: new Blob(['unavailable parser']) }),
    ).rejects.toThrow();
    expect(loadEpub).toHaveBeenCalledTimes(1);
  });
});
