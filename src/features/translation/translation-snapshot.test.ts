import { describe, expect, it, vi } from 'vitest';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { translationSnapshot } from './translation-snapshot';

describe('translation snapshot lifetime', () => {
  it('rejects a source page which resolves after cancellation even if the repository ignores abort', async () => {
    let resolve!: (value: unknown) => void;
    const repository = {
      getParagraphPage: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    } as unknown as ReaderBodyRepository;
    const abort = new AbortController();
    const pending = translationSnapshot(repository, { id: 'chapter', paragraphCount: 1 }, abort.signal);
    abort.abort();
    resolve({ paragraphs: [{ id: 'p1', text: 'Late source' }] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects incomplete source pages and keeps EPUB nontext out of the text projection', async () => {
    const repository = {
      getParagraphPage: vi.fn().mockResolvedValue({
        paragraphs: [
          { id: 'p1', text: 'Source' },
          { id: 'image', text: 'Caption', documentKind: 'image' },
        ],
      }),
    } as unknown as ReaderBodyRepository;
    await expect(
      translationSnapshot(repository, { id: 'chapter', paragraphCount: 3 }, new AbortController().signal),
    ).rejects.toThrow('translation_source_changed');
    await expect(
      translationSnapshot(repository, { id: 'chapter', paragraphCount: 2 }, new AbortController().signal),
    ).resolves.toEqual([{ id: 'p1', text: 'Source' }]);
  });
});
