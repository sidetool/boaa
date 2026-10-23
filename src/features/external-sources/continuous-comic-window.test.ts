import { describe, expect, it, vi } from 'vitest';
import { SourceStreamBuffer } from '../../external-sources/source-stream-buffer';
import { ContinuousComicWindow } from './continuous-comic-window';
import type { SourceStreamEpisode } from './SourceStreamReader';

const episode = (index: number): SourceStreamEpisode => ({
  remoteId: String(index),
  title: `합성 ${index}`,
  historyKey: `synthetic:${index}`,
  onSave: vi.fn(async () => undefined),
});

describe('continuous comic window', () => {
  it('navigates from the observed episode rather than the retained window edge', async () => {
    const buffer = new SourceStreamBuffer({
      open: async () => ({
        pageCount: 3,
        loadPage: async () => new Blob(),
        close: () => undefined,
      }),
    });
    const lookup = vi.fn(async (id: string, direction: -1 | 1, _signal: AbortSignal) =>
      Number(id) + direction >= 2 ? episode(Number(id) + direction) : undefined,
    );
    const window = new ContinuousComicWindow(
      episode(2),
      await buffer.open('2', new AbortController().signal),
      buffer,
      lookup,
      vi.fn(),
      vi.fn(),
    );
    const release = window.acquire();
    await window.prepare(-1); // The known beginning is episode 2.
    expect(window.canNavigate(-1)).toBe(false);
    expect((await window.adjacent(1))?.episode.remoteId).toBe('3');
    window.observe(3); // First page of the newly displayed episode.
    expect(window.canNavigate(-1)).toBe(true);
    expect((await window.adjacent(-1))?.episode.remoteId).toBe('2');
    expect(lookup.mock.calls).toEqual([
      ['2', -1, expect.anything()],
      ['2', 1, expect.anything()],
    ]);
    release();
    await Promise.resolve();
    buffer.close();
  });

  it('waits for opposite-edge preparation instead of dropping explicit previous navigation', async () => {
    let release!: (entry: SourceStreamEpisode) => void;
    const buffer = new SourceStreamBuffer({
      open: async () => ({
        pageCount: 3,
        loadPage: async () => new Blob(),
        close: () => undefined,
      }),
    });
    const lookup = vi.fn((id: string, direction: -1 | 1) =>
      direction === 1
        ? new Promise<SourceStreamEpisode>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(episode(Number(id) - 1)),
    );
    const window = new ContinuousComicWindow(
      episode(2),
      await buffer.open('2', new AbortController().signal),
      buffer,
      lookup,
      vi.fn(),
      vi.fn(),
    );
    const releaseOwner = window.acquire();
    const preparation = window.prepare(1);
    await Promise.resolve();
    const previous = window.adjacent(-1);
    release(episode(3));
    await preparation;
    expect((await previous)?.episode.remoteId).toBe('1');
    expect(lookup).toHaveBeenCalledTimes(2);
    releaseOwner();
    await Promise.resolve();
    buffer.close();
  });

  it('keeps page and asset identity, bounds retained releases, and does not visit prepared pages', async () => {
    const loaded: string[] = [];
    const closed: string[] = [];
    const buffer = new SourceStreamBuffer({
      open: async (id) => ({
        pageCount: 3,
        loadPage: async (index) => {
          loaded.push(`${id}:${index}`);
          return new Blob([`${id}:${index}`]);
        },
        close: () => closed.push(id),
      }),
    });
    const signal = new AbortController().signal;
    const observed = vi.fn();
    const window = new ContinuousComicWindow(
      episode(1),
      await buffer.open('1', signal),
      buffer,
      async (id, direction) => (Number(id) + direction >= 0 ? episode(Number(id) + direction) : undefined),
      vi.fn(),
      observed,
    );
    const release = window.acquire();
    const before = window.chapters[0];
    const repository = window.repository,
      assets = window.assets;
    await window.prepare(1);
    await window.prepare(-1);
    expect(window.chapters[3].id).toBe(before.id);
    expect(window.repository).toBe(repository);
    expect(window.assets).toBe(assets);
    expect(loaded).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    const resource = await assets.getEmbeddedResource(window.novel.id, before.id, signal);
    expect(await resource!.blob.text()).toBe('1:0');
    window.observe(3);
    expect(observed).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index++) {
      await window.prepare(1);
      window.observe(window.chapters.length - 1);
    }
    expect(window.entries.length).toBeLessThanOrEqual(5);
    expect(closed.length).toBeGreaterThan(0);
    release();
    await Promise.resolve();
    buffer.close();
  });
});
