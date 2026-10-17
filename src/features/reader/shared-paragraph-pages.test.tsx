import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParagraphPage } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { invalidateSharedParagraphPages, loadSharedParagraphPage } from './shared-paragraph-pages';
import { useParagraphPages, type ParagraphPagesController } from './use-paragraph-pages';

const page = { paragraphs: [{ id: 'p1', index: 1, text: 'Opening' }] } as ParagraphPage;
const repositoryFor = (getParagraphPage: unknown) => ({ getParagraphPage }) as ReaderBodyRepository;
afterEach(() => vi.useRealTimers());

describe('shared paragraph source pages', () => {
  it('records the uncached mode-switch baseline: two requests and an extra 180ms', async () => {
    vi.useFakeTimers();
    const getParagraphPage = vi.fn(() => new Promise<ParagraphPage>((resolve) => setTimeout(() => resolve(page), 180)));
    const repository = repositoryFor(getParagraphPage);
    const paginated = loadSharedParagraphPage(repository, 'r', 'c', 0);
    await vi.advanceTimersByTimeAsync(180);
    await paginated;
    let controller!: ParagraphPagesController;
    function OldScrollProbe() {
      // Omitting the revision retains the original isolated source-load path.
      controller = useParagraphPages(repository, 'c', 120);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<OldScrollProbe />);
    });
    const started = Date.now();
    await act(async () => {
      const loading = controller.loadIndexes([0]);
      await vi.advanceTimersByTimeAsync(180);
      await loading;
    });
    expect(Date.now() - started).toBe(180);
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it('removes the second 180ms network wait when a paginated reader switches to scroll', async () => {
    vi.useFakeTimers();
    const getParagraphPage = vi.fn(() => new Promise<ParagraphPage>((resolve) => setTimeout(() => resolve(page), 180)));
    const repository = repositoryFor(getParagraphPage);
    const pending = loadSharedParagraphPage(repository, 'revision-1', 'chapter-1', 0);
    await vi.advanceTimersByTimeAsync(180);
    await pending;
    let controller!: ParagraphPagesController;
    function Probe({ revision = 'revision-1' }: { revision?: string }) {
      controller = useParagraphPages(repository, 'chapter-1', 120, revision);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
    });
    const started = Date.now();
    await act(async () => controller.loadIndexes([0]));
    expect(Date.now() - started).toBe(0);
    expect(controller.paragraphAt(0)).toEqual(page.paragraphs[0]);
    expect(getParagraphPage).toHaveBeenCalledTimes(1);
    // A real mode unmount/remount still reuses the source page.
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<Probe />);
    });
    await act(async () => controller.loadIndexes([0]));
    expect(getParagraphPage).toHaveBeenCalledTimes(1);
    await act(async () => renderer.update(<Probe revision="revision-2" />));
    expect(controller.paragraphAt(0)).toBeUndefined();
    await act(async () => {
      const fresh = controller.loadIndexes([0]);
      await vi.advanceTimersByTimeAsync(180);
      await fresh;
    });
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

  it('deduplicates an in-flight warmup and keeps unrelated foreground requests independent', async () => {
    let finish!: (page: ParagraphPage) => void;
    const getParagraphPage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(page);
    const repository = repositoryFor(getParagraphPage);
    const warmup = loadSharedParagraphPage(repository, 'r', 'next', 0);
    expect(loadSharedParagraphPage(repository, 'r', 'next', 0)).toBe(warmup);
    expect(await loadSharedParagraphPage(repository, 'r', 'current', 1)).toBe(page);
    expect(getParagraphPage).toHaveBeenCalledTimes(2);
    finish(page);
    await warmup;
  });

  it('isolates repositories and revisions and does not retain failures or missing pages', async () => {
    const getParagraphPage = vi.fn().mockResolvedValue(page);
    const first = repositoryFor(getParagraphPage);
    const second = repositoryFor(getParagraphPage);
    await loadSharedParagraphPage(first, 'r1', 'c', 0);
    await loadSharedParagraphPage(second, 'r1', 'c', 0);
    await loadSharedParagraphPage(first, 'r2', 'c', 0);
    expect(getParagraphPage).toHaveBeenCalledTimes(3);
    getParagraphPage.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    await expect(loadSharedParagraphPage(first, 'r1', 'c', 1)).rejects.toThrow('offline');
    expect(await loadSharedParagraphPage(first, 'r1', 'c', 1)).toBeUndefined();
    expect(await loadSharedParagraphPage(first, 'r1', 'c', 1)).toBe(page);
  });

  it('bounds retention and prevents invalidated pending loads from replacing newer content', async () => {
    let finish!: (page: ParagraphPage) => void;
    const getParagraphPage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(page);
    const repository = repositoryFor(getParagraphPage);
    const old = loadSharedParagraphPage(repository, 'r', 'c', 0);
    invalidateSharedParagraphPages(repository, 'c');
    const fresh = await loadSharedParagraphPage(repository, 'r', 'c', 0);
    finish({ paragraphs: [] } as unknown as ParagraphPage);
    await old;
    expect(await loadSharedParagraphPage(repository, 'r', 'c', 0)).toBe(fresh);
    for (let index = 1; index <= 64; index += 1) await loadSharedParagraphPage(repository, 'r', 'c', index);
    const before = getParagraphPage.mock.calls.length;
    await loadSharedParagraphPage(repository, 'r', 'c', 0);
    expect(getParagraphPage).toHaveBeenCalledTimes(before + 1);
  });
});
