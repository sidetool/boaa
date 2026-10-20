import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSLATION_SETTINGS, type TranslationResult } from '../../translation/contracts';
import { useReaderTranslation, type ReaderTranslationController } from './use-reader-translation';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
const client = vi.hoisted(() => ({ configuration: vi.fn(), request: vi.fn(), result: vi.fn(), cancel: vi.fn() }));
vi.mock('./translation-client', () => ({ useTranslationClient: () => activeClient, translationError: () => '실패' }));
let activeClient: typeof client | undefined;
let renderer: ReactTestRenderer;
let controller: ReaderTranslationController;
let model: ReaderScreenModel;
let repository: ReaderBodyRepository;
function Harness() {
  controller = useReaderTranslation(model, repository);
  return null;
}
const result = (overrides: Partial<TranslationResult> = {}): TranslationResult => ({
  id: 'job',
  workKey: 'book',
  chapterKey: 'chapter',
  sourceHash: 'hash',
  status: 'queued',
  targetLanguage: 'ko',
  provider: 'gemini',
  model: 'synthetic',
  completed: 0,
  total: 1,
  paragraphs: [],
  ...overrides,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  activeClient = client;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { visibilityState: 'visible' });
  model = {
    novel: { id: 'book', format: 'txt', activeContentRevisionId: 'r' },
    chapter: { id: 'chapter', paragraphCount: 1, textHash: 'current-hash' },
    chapters: [{ id: 'chapter', paragraphCount: 1 }],
  } as unknown as ReaderScreenModel;
  repository = {
    getParagraphPage: vi.fn().mockResolvedValue({ paragraphs: [{ id: 'p1', text: 'A synthetic text paragraph.' }] }),
  } as unknown as ReaderBodyRepository;
  client.configuration.mockResolvedValue({
    settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, model: 'synthetic' },
    revision: 1,
    credentials: { gemini: { saved: true } },
  });
  client.request.mockResolvedValue({ result: null });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
describe('reader translation lifecycle', () => {
  it('does no source reads or job requests when disabled', async () => {
    client.configuration.mockResolvedValue({ settings: DEFAULT_TRANSLATION_SETTINGS, revision: 0, credentials: {} });
    await mount();
    expect(repository.getParagraphPage).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
  it('only looks up existing results in manual mode and does not loop when model objects change', async () => {
    await mount();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toMatchObject({ lookupOnly: true });
    model = { ...model, chapter: { ...model.chapter }, chapters: [...model.chapters] };
    await act(async () => renderer.update(<Harness />));
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it('polls sequentially, shows validated output, and returns to original during TTS', async () => {
    await mount();
    client.request.mockResolvedValue({ result: result() });
    await act(async () => controller.start('en'));
    expect(client.request.mock.calls.at(-1)?.[0]).toMatchObject({ sourceLanguage: 'en', confirmUnknownLanguage: true });
    client.result.mockResolvedValue(
      result({ status: 'complete', completed: 1, paragraphs: [{ id: 'p1', text: '번역문' }] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.texts?.get('p1')).toBe('번역문');
    model = { ...model, ttsIndex: 1 };
    await act(async () => renderer.update(<Harness />));
    expect(controller.displaying).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(client.result).toHaveBeenCalledTimes(1);
  });
  it.each([
    { automatic: false, nextChapters: 2, expected: 0 },
    { automatic: true, nextChapters: 0, expected: 0 },
    { automatic: true, nextChapters: 2, expected: 2 },
  ])(
    'prefetch respects automatic=$automatic and nextChapters=$nextChapters',
    async ({ automatic, nextChapters, expected }) => {
      model = {
        ...model,
        novel: { ...model.novel, language: 'en' },
        chapters: [
          model.chapter,
          { ...model.chapter, id: 'next-1', textHash: 'next-hash-1' },
          { ...model.chapter, id: 'next-2', textHash: 'next-hash-2' },
        ],
      };
      client.configuration.mockResolvedValue({
        settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, model: 'synthetic', automatic, nextChapters },
        revision: 1,
        credentials: {},
      });
      client.request.mockImplementation(async (request) => ({
        result: request.lookupOnly
          ? null
          : result({ status: 'complete', completed: 1, paragraphs: [{ id: 'p1', text: '번역문' }] }),
      }));
      await mount();
      if (!automatic) await act(async () => controller.start('en'));
      const prefetch = client.request.mock.calls.filter(([request]) => request.prefetch);
      expect(prefetch).toHaveLength(expected);
      if (expected) {
        expect(prefetch.map(([request]) => request.chapterKey)).toEqual(['next-1', 'next-2']);
        expect(prefetch.map(([request]) => request.chapterTextHash)).toEqual(['next-hash-1', 'next-hash-2']);
      }
    },
  );
  it.each([false, true])(
    'automatically translates the next chapter with the correct stored/stream source (transient=%s)',
    async (transient) => {
      model = { ...model, transient, novel: { ...model.novel, language: 'en' } };
      client.configuration.mockResolvedValue({
        settings: {
          ...DEFAULT_TRANSLATION_SETTINGS,
          enabled: true,
          automatic: true,
          nextChapters: 0,
          model: 'synthetic',
        },
        revision: 1,
        credentials: {},
      });
      client.request.mockImplementation(async (request) => ({
        result: request.lookupOnly ? null : result({ chapterKey: request.chapterKey, status: 'complete' }),
      }));
      await mount();
      model = { ...model, chapter: { ...model.chapter, id: 'next', textHash: 'next-hash' } };
      await act(async () => renderer.update(<Harness />));
      const request = client.request.mock.calls.filter(([r]) => !r.lookupOnly).at(-1)?.[0];
      expect(request.chapterKey).toBe('next');
      if (transient) {
        expect(request.bookId).toBeUndefined();
        expect(request.paragraphs).toEqual([{ id: 'p1', text: 'A synthetic text paragraph.' }]);
      } else expect(request).toMatchObject({ bookId: 'book', revision: 'r', chapterTextHash: 'next-hash' });
      expect(controller.error).toBe('');
    },
  );
  it('ignores a previous chapter response after navigation', async () => {
    await mount();
    let resolve!: (value: { result: TranslationResult }) => void;
    client.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = controller.start('en');
      await Promise.resolve();
    });
    model = { ...model, chapter: { ...model.chapter, id: 'next' } };
    client.request.mockResolvedValue({ result: null });
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      resolve({ result: result({ paragraphs: [{ id: 'p1', text: 'stale' }] }) });
      await pending;
    });
    expect(controller.result).toBeUndefined();
  });
  it('rebuilds source identity when a streaming chapter becomes a saved chapter', async () => {
    model = { ...model, transient: true, novel: { ...model.novel, language: 'en' } };
    await mount();
    expect(client.request.mock.calls.at(-1)?.[0].paragraphs).toHaveLength(1);
    model = { ...model, transient: false };
    await act(async () => renderer.update(<Harness />));
    expect(client.request.mock.calls.at(-1)?.[0]).toMatchObject({ bookId: 'book', chapterTextHash: 'current-hash' });
    expect(client.request.mock.calls.at(-1)?.[0].paragraphs).toBeUndefined();
  });
  it('keeps the newest settings when configuration requests finish out of order', async () => {
    await mount();
    let resolve!: (value: unknown) => void;
    client.configuration.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('boaa-translation-settings'));
    });
    client.configuration.mockResolvedValueOnce({
      settings: DEFAULT_TRANSLATION_SETTINGS,
      revision: 3,
      credentials: {},
    });
    await act(async () => {
      window.dispatchEvent(new Event('boaa-translation-settings'));
    });
    await act(async () => {
      resolve({
        settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, model: 'old' },
        revision: 2,
        credentials: {},
      });
    });
    expect(controller.available).toBe(false);
    expect(controller.configuration?.revision).toBe(3);
  });
  it('does not replace a manual start with a late cache lookup', async () => {
    let resolve!: (value: { result: TranslationResult | null }) => void;
    client.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await mount();
    client.request.mockResolvedValueOnce({ result: result() });
    await act(async () => controller.start('en'));
    await act(async () => {
      resolve({ result: null });
    });
    expect(controller.result?.id).toBe('job');
    expect(controller.displaying).toBe(true);
  });
  it('does not send the next chapter after a slow source read becomes hidden', async () => {
    model = {
      ...model,
      novel: { ...model.novel, language: 'en' },
      chapters: [model.chapter, { ...model.chapter, id: 'next' }],
    };
    client.configuration.mockResolvedValue({
      settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, automatic: true, model: 'synthetic' },
      revision: 1,
      credentials: {},
    });
    client.request.mockImplementation(async (request) => ({
      result: request.lookupOnly ? null : result({ status: 'complete' }),
    }));
    let resolve!: (value: unknown) => void;
    vi.mocked(repository.getParagraphPage).mockImplementation(async (chapter) =>
      chapter === 'next'
        ? (new Promise((done) => {
            resolve = done;
          }) as never)
        : ({ paragraphs: [{ id: 'p1', text: 'Synthetic original' }] } as never),
    );
    await mount();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      resolve({ paragraphs: [{ id: 'n1', text: 'Synthetic next chapter' }] });
    });
    expect(client.request.mock.calls.filter(([request]) => request.prefetch)).toHaveLength(0);
  });
  it('does not start an automatic request after choosing original during a delayed lookup', async () => {
    model = { ...model, novel: { ...model.novel, language: 'en' } };
    client.configuration.mockResolvedValue({
      settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, automatic: true, model: 'synthetic' },
      revision: 1,
      credentials: {},
    });
    let resolve!: (value: { result: TranslationResult }) => void;
    client.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await mount();
    await act(async () => controller.showOriginal());
    await act(async () => {
      resolve({ result: result() });
    });
    expect(client.request.mock.calls.filter(([request]) => !request.lookupOnly)).toHaveLength(0);
    expect(controller.displaying).toBe(false);
  });

  it('waits for the new account configuration instead of using the previous client settings', async () => {
    model = { ...model, novel: { ...model.novel, language: 'en' } };
    await mount();
    const next = { ...client, configuration: vi.fn(() => new Promise(() => {})), request: vi.fn() };
    activeClient = next;
    await act(async () => renderer.update(<Harness />));
    expect(controller.available).toBe(false);
    expect(controller.result).toBeUndefined();
    expect(next.request).not.toHaveBeenCalled();
  });
  it('discards a late poll after canceling even when transport ignores abort', async () => {
    await mount();
    client.request.mockResolvedValueOnce({ result: result() });
    await act(async () => controller.start('en'));
    let resolve!: (value: TranslationResult) => void;
    client.result.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    client.result.mockResolvedValueOnce(result({ status: 'cancelled' }));
    await act(async () => controller.cancel());
    await act(async () => {
      resolve(result({ status: 'running', paragraphs: [{ id: 'p1', text: 'Late' }] }));
    });
    expect(controller.result?.status).toBe('cancelled');
    expect(controller.result?.paragraphs).toEqual([]);
  });
  it('does not let a pre-start poll replace the result of a new manual request', async () => {
    await mount();
    client.request.mockResolvedValue({ result: result() });
    await act(async () => controller.start('en'));
    let resolve!: (value: TranslationResult) => void;
    client.result.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    await act(async () => controller.start('en'));
    await act(async () => {
      resolve(result({ status: 'failed', error: 'old execution' }));
    });
    expect(controller.result?.status).toBe('queued');
    client.result.mockResolvedValueOnce(result({ status: 'complete' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.result?.status).toBe('complete');
  });
  it('resumes status polling after a manual request fails', async () => {
    await mount();
    client.request.mockResolvedValueOnce({ result: result() });
    await act(async () => controller.start('en'));
    client.request.mockRejectedValueOnce(new Error('temporary request failure'));
    await act(async () => controller.start('en'));
    expect(controller.busy).toBe(false);
    client.result.mockResolvedValueOnce(result({ status: 'complete' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.result?.status).toBe('complete');
  });
  it('serializes cancellation refresh with polling while the refresh is slow', async () => {
    await mount();
    client.request.mockResolvedValue({ result: result() });
    await act(async () => controller.start('en'));
    let resolve!: (value: TranslationResult) => void;
    client.result.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = controller.cancel();
      await Promise.resolve();
    });
    client.result.mockResolvedValue(result({ status: 'complete' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(client.result).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(result({ status: 'cancelled' }));
      await pending;
    });
    expect(controller.result?.status).toBe('cancelled');
  });
  it('admits only one manual request from simultaneous clicks', async () => {
    await mount();
    client.request.mockResolvedValue({ result: result() });
    await act(async () => {
      await Promise.all([controller.start('en'), controller.start('en')]);
    });
    expect(client.request.mock.calls.filter(([request]) => !request.lookupOnly)).toHaveLength(1);
  });
  it('uses the next chapter language and skips already-target-language content', async () => {
    model = {
      ...model,
      novel: { ...model.novel, language: 'en' },
      chapters: [model.chapter, { ...model.chapter, id: 'next' }],
    };
    client.configuration.mockResolvedValue({
      settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, automatic: true, model: 'synthetic' },
      revision: 1,
      credentials: {},
    });
    client.request.mockImplementation(async (request) => ({
      result: request.lookupOnly ? null : result({ status: 'complete' }),
    }));
    vi.mocked(repository.getParagraphPage).mockImplementation(
      async (chapter) =>
        ({
          paragraphs: [
            {
              id: chapter,
              text:
                chapter === 'next'
                  ? '다음 회차는 이미 한국어로 작성된 소설 본문입니다. '.repeat(4)
                  : 'Synthetic source',
            },
          ],
        }) as never,
    );
    await mount();
    expect(client.request.mock.calls.filter(([request]) => request.prefetch)).toHaveLength(0);
  });

  it('ends an authorized streaming prefetch when the chapter changes during preparation', async () => {
    let resolve!: (value: unknown) => void;
    const prepareTranslationNext = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    model = {
      ...model,
      transient: true,
      novel: { ...model.novel, language: 'en' },
      navigation: { prepareTranslationNext },
    } as unknown as ReaderScreenModel;
    client.configuration.mockResolvedValue({
      settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true, automatic: true, model: 'synthetic' },
      revision: 1,
      credentials: {},
    });
    client.request.mockImplementation(async (request) => ({
      result: request.lookupOnly ? null : result({ chapterKey: request.chapterKey, status: 'complete' }),
    }));
    await mount();
    expect(prepareTranslationNext).toHaveBeenCalledTimes(1);
    model = { ...model, chapter: { ...model.chapter, id: 'elsewhere' }, navigation: undefined };
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      resolve({
        workKey: 'book',
        chapterKey: 'prepared-next',
        paragraphs: [{ id: 'n1', text: 'Authorized next source' }],
      });
    });
    expect(client.request.mock.calls.filter(([request]) => request.prefetch)).toHaveLength(0);
  });
  it('keeps polling when cancellation fails instead of reporting a successful cancellation', async () => {
    await mount();
    client.request.mockResolvedValueOnce({ result: result() });
    await act(async () => controller.start('en'));
    client.cancel.mockRejectedValueOnce(new Error('network failure'));
    await act(async () => controller.cancel());
    expect(controller.result?.status).toBe('queued');
    expect(controller.error).toBe('실패');
    client.result.mockResolvedValueOnce(
      result({ status: 'complete', paragraphs: [{ id: 'p1', text: 'Completed on server' }] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.result?.status).toBe('complete');
  });
  it('retries authoritative status polling when cancel succeeds but its immediate refresh fails', async () => {
    await mount();
    client.request.mockResolvedValueOnce({ result: result() });
    await act(async () => controller.start('en'));
    client.result.mockRejectedValueOnce(new Error('temporary disconnect'));
    await act(async () => controller.cancel());
    expect(controller.result?.status).toBe('queued');
    client.result.mockResolvedValueOnce(result({ status: 'cancelled' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(controller.result?.status).toBe('cancelled');
  });
});
