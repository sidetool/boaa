import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBookWorkspaceReaderArtifacts,
  invalidateBookWorkspaceReaderArtifacts,
} from './book-workspace-reader-artifacts';

afterEach(() => vi.useRealTimers());

describe('chapter reader artifact loading', () => {
  it('overlaps independent reads instead of adding a second network round trip', async () => {
    vi.useFakeTimers();
    const response = () => new Promise<[]>((resolve) => setTimeout(() => resolve([]), 80));
    const repository = {
      listSegments: vi.fn(response),
      listCharacters: vi.fn(response),
      listVoiceProfiles: vi.fn(response),
    };
    let completed = false;
    const request = loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book').then((result) => {
      completed = true;
      return result;
    });
    expect(repository.listSegments).toHaveBeenCalledWith('chapter');
    expect(repository.listCharacters).toHaveBeenCalledWith('book');
    expect(repository.listVoiceProfiles).toHaveBeenCalledWith('book');
    await vi.advanceTimersByTimeAsync(79);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(true);
    await expect(request).resolves.toEqual({ segments: [], characters: [], voiceProfiles: [] });
  });

  it('does not query another book when the chapter has no book context', async () => {
    const repository = {
      listSegments: vi.fn(async () => []),
      listCharacters: vi.fn(async () => []),
      listVoiceProfiles: vi.fn(async () => []),
    };
    await expect(loadBookWorkspaceReaderArtifacts(repository, 'chapter')).resolves.toEqual({
      segments: [],
      characters: [],
      voiceProfiles: [],
    });
    expect(repository.listCharacters).not.toHaveBeenCalled();
    expect(repository.listVoiceProfiles).not.toHaveBeenCalled();
  });

  it('rejects a failed read without returning partial chapter artifacts', async () => {
    const error = new Error('segments unavailable');
    await expect(
      loadBookWorkspaceReaderArtifacts(
        {
          listSegments: async () => {
            throw error;
          },
          listCharacters: async () => [],
          listVoiceProfiles: async () => [],
        },
        'chapter',
        'book',
      ),
    ).rejects.toBe(error);
  });
});

it('consumes one repository/revision-scoped prefetch and retries failures', async () => {
  const repository = {
    listSegments: vi.fn(async () => []),
    listCharacters: vi.fn(async () => []),
    listVoiceProfiles: vi.fn(async () => []),
  };
  await loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'r1' });
  await loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'r1', consume: true });
  expect(repository.listSegments).toHaveBeenCalledTimes(1);
  await loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'r1', consume: true });
  expect(repository.listSegments).toHaveBeenCalledTimes(2);
  await loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'r2' });
  expect(repository.listSegments).toHaveBeenCalledTimes(3);
  await loadBookWorkspaceReaderArtifacts({ ...repository }, 'chapter', 'book', { revision: 'r2' });
  expect(repository.listSegments).toHaveBeenCalledTimes(4);
  repository.listSegments.mockRejectedValueOnce(new Error('offline'));
  await expect(loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'failed' })).rejects.toThrow(
    'offline',
  );
  await loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'failed', consume: true });
  expect(repository.listSegments).toHaveBeenCalledTimes(6);
});

it('discards pending prepared artifacts at the authenticated repository boundary', async () => {
  let resolve!: (value: []) => void;
  const repository = {
    listSegments: vi.fn(
      () =>
        new Promise<[]>((done) => {
          resolve = done;
        }),
    ),
    listCharacters: vi.fn(async () => []),
    listVoiceProfiles: vi.fn(async () => []),
  };
  const pending = loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', { revision: 'same-revision' });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  invalidateBookWorkspaceReaderArtifacts(repository);
  resolve([]);
  await rejected;
  const fresh = loadBookWorkspaceReaderArtifacts(repository, 'chapter', 'book', {
    revision: 'same-revision',
    consume: true,
  });
  expect(repository.listSegments).toHaveBeenCalledTimes(2);
  resolve([]);
  await fresh;
});
