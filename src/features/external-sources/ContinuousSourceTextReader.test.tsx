import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReaderScreen from '../reader/ReaderScreen';
import { defaultSettings } from '../../repositories/reader-defaults';
import { sourceTextDocument } from './source-text-document';
import { ContinuousSourceTextReader } from './ContinuousSourceTextReader';
import type { SourceStreamEpisode } from './SourceStreamReader';
import { loadSharedParagraphPage, peekSharedParagraphPage } from '../reader/shared-paragraph-pages';

vi.mock('../reader/ReaderScreen', () => ({ default: vi.fn(() => null) }));
vi.mock('./use-source-reading-preferences', () => ({
  useSourceReadingPreferences: () => ({ mode: 'stream-save', prefetch: 5 }),
}));
const renderers: ReactTestRenderer[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0))
    await act(async () => {
      renderer.unmount();
    });
  vi.clearAllMocks();
});
const model = () => vi.mocked(ReaderScreen).mock.lastCall![0].model;

async function harness(
  neighbor: (id: string, direction: -1 | 1, signal: AbortSignal) => Promise<SourceStreamEpisode | undefined>,
) {
  const initial = await sourceTextDocument({
    text: '합성 첫 문단입니다.\n\n두 번째 문단입니다.',
    title: '첫 화',
    workId: 'synthetic-work',
    episodeId: 'one',
    historyKey: 'synthetic-one',
    settings: defaultSettings,
    fromStart: true,
  });
  const save = vi.fn(async () => undefined);
  const open = vi.fn(async () => ({ text: '합성 다음 화입니다.\n\n다음 문단입니다.' }));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ContinuousSourceTextReader
        remoteId="one"
        title="첫 화"
        historyKey="synthetic-one"
        profileKey="synthetic-work"
        port={{ kind: 'text', open }}
        onSave={save}
        onClose={vi.fn()}
        neighbor={neighbor}
        initial={initial}
        textReader={{
          settings: defaultSettings,
          settingsOpen: false,
          actions: {
            openSettings: vi.fn(),
            flushReadingSettings: vi.fn(),
            retryReadingSettings: vi.fn(),
            adjustFontSize: vi.fn(),
            adjustContentWidth: vi.fn(),
            toggleNightTheme: vi.fn(),
            updateReadingProfile: vi.fn(),
            setReadingBookOverride: vi.fn(),
            closeActiveLayer: vi.fn(),
            notify: vi.fn(),
          },
        }}
      />,
    );
  });
  renderers.push(renderer);
  return { initial, renderer, open, save };
}

describe('continuous streaming text ownership', () => {
  it('shares one bounded page cache across a long work and routes saved positions to the correct episode', async () => {
    let number = 0;
    const onPosition = vi.fn(async () => undefined);
    const { initial } = await harness(async () => ({
      remoteId: `episode-${++number}`,
      title: `합성 ${number}화`,
      historyKey: `synthetic-${number}`,
      onSave: vi.fn(async () => undefined),
      onTextPosition: onPosition,
    }));
    const source = model().continuousSource!;
    const repository = vi.mocked(ReaderScreen).mock.lastCall![0].repository!;
    let id = initial.chapter.id;
    let firstId = '',
      lastId = '';
    await act(async () => {
      for (let index = 0; index < 80; index++) {
        const next = (await source.neighbor(id, 1, new AbortController().signal))!;
        expect(next.repository).toBe(repository);
        id = next.chapter.id;
        firstId ||= id;
        lastId = id;
        await loadSharedParagraphPage(next.repository, 'audit-revision', id, 0);
        source.retain?.([id]);
      }
    });
    expect(peekSharedParagraphPage(repository, 'audit-revision', firstId, 0)).toBeUndefined();
    expect(peekSharedParagraphPage(repository, 'audit-revision', lastId, 0)).toBeDefined();
    await repository.saveReadingPosition({
      novelId: initial.novel.id,
      chapterId: lastId,
      expectedContentRevisionId: initial.novel.activeContentRevisionId,
      paragraphIndex: 2,
      offsetInParagraph: 3,
      chapterProgress: 0.5,
      scrollTop: 40,
    });
    expect(onPosition).toHaveBeenCalledOnce();
    expect(onPosition).toHaveBeenCalledWith(expect.objectContaining({ paragraphIndex: 2, offset: 3 }));
  });

  it('honors backward end placement after resolving a placeholder and keeps navigation options', async () => {
    await harness(async () => ({
      remoteId: 'previous',
      title: '이전 화',
      historyKey: 'synthetic-previous',
      onSave: vi.fn(async () => undefined),
    }));
    const handle = vi.mocked(ReaderScreen).mock.lastCall![0].screenHandle;
    const target = model().chapters.find((chapter) => chapter.index < model().chapter.index)!;
    await act(async () => {
      await handle.getActions().openChapter(target, {
        restore: true,
        preserveSearch: true,
        initialMode: 'read',
        position: {
          id: 'edge',
          novelId: model().novel.id,
          chapterId: target.id,
          paragraphIndex: 999,
          offsetInParagraph: 0,
          chapterProgress: 1,
          scrollTop: Number.MAX_SAFE_INTEGER,
          deviceId: 'test',
          updatedAt: new Date().toISOString(),
        },
      });
    });
    expect(handle.peekOpen(model().chapter.id)).toMatchObject({
      restore: true,
      preserveSearch: true,
      position: { chapterId: model().chapter.id, paragraphIndex: 2, chapterProgress: 1 },
    });
  });

  it('does not commit an explicit navigation cancelled during neighbor preparation', async () => {
    let release!: (episode: SourceStreamEpisode) => void;
    const { initial } = await harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const handle = vi.mocked(ReaderScreen).mock.lastCall![0].screenHandle;
    const target = model().chapters.find((chapter) => chapter.index > model().chapter.index)!;
    const controller = new AbortController();
    let pending!: Promise<void>;
    await act(async () => {
      pending = handle.getActions().openChapter(target, { navigationSignal: controller.signal });
    });
    controller.abort();
    await act(async () => {
      release({ remoteId: 'two', title: '다음 화', historyKey: 'synthetic-two', onSave: vi.fn() });
      await pending;
    });
    expect(model().chapter.id).toBe(initial.chapter.id);
    expect(handle.peekOpen(initial.chapter.id)?.sequence).toBe(1);
  });

  it('shares metadata preparation while cancelling only the retired consumer; visits start on observation', async () => {
    let release!: (episode: SourceStreamEpisode) => void;
    const lookup = vi.fn(
      () =>
        new Promise<SourceStreamEpisode>((resolve) => {
          release = resolve;
        }),
    );
    const { initial, open } = await harness(lookup);
    const source = model().continuousSource!;
    const retired = new AbortController();
    const save = vi.fn(async () => undefined);
    let first!: Promise<unknown>, second!: ReturnType<typeof source.neighbor>;
    await act(async () => {
      first = source.neighbor(initial.chapter.id, 1, retired.signal).catch((error) => error);
      second = source.neighbor(initial.chapter.id, 1, new AbortController().signal);
      await Promise.resolve();
    });
    retired.abort();
    expect((await first) instanceof DOMException).toBe(true);
    let target!: Awaited<typeof second>;
    await act(async () => {
      release({ remoteId: 'two', title: '둘째 화', historyKey: 'synthetic-two', onSave: save });
      target = await second;
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(model().chapter.id).toBe(initial.chapter.id);
    expect(save).not.toHaveBeenCalled();
    const page = await target!.repository.getParagraphPage(target!.chapter.id, 0);
    expect(page?.paragraphs[0].chapterId).toBe(target!.chapter.id);
    expect(page?.paragraphs[0].index).toBe(1);
    await act(async () => {
      source.observed?.(target!.chapter.id);
      source.observed?.(target!.chapter.id);
    });
    expect(model().chapter.id).toBe(target!.chapter.id);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('shares next translation preparation with scrolling without visiting or saving the episode', async () => {
    const save = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => ({
      remoteId: 'two',
      title: '둘째 화',
      historyKey: 'synthetic-two',
      onSave: save,
    }));
    const { initial, open } = await harness(lookup);
    const source = model().continuousSource!;
    let prepared!: Awaited<
      ReturnType<NonNullable<NonNullable<ReturnType<typeof model>['navigation']>['prepareTranslationNext']>>
    >;
    await act(async () => {
      const [translation, neighbor] = await Promise.all([
        model().navigation!.prepareTranslationNext!(new AbortController().signal),
        source.neighbor(initial.chapter.id, 1, new AbortController().signal),
      ]);
      prepared = translation;
      expect(prepared?.chapterKey).toBe(neighbor?.chapter.id);
    });
    expect(prepared?.workKey).toBe(initial.novel.id);
    expect(prepared?.paragraphs?.length).toBeGreaterThan(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(model().chapter.id).toBe(initial.chapter.id);
  });

  it('ignores late neighbor resolution after the work is closed', async () => {
    let release!: (episode: SourceStreamEpisode) => void;
    const lookup = vi.fn(
      () =>
        new Promise<SourceStreamEpisode>((resolve) => {
          release = resolve;
        }),
    );
    const { initial, renderer, open } = await harness(lookup);
    const source = model().continuousSource!;
    const pending = source.neighbor(initial.chapter.id, 1, new AbortController().signal).catch((error) => error);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      renderer.unmount();
    });
    renderers.splice(renderers.indexOf(renderer), 1);
    release({ remoteId: 'two', title: '둘째 화', historyKey: 'synthetic-two', onSave: vi.fn() });
    expect(await pending).toBeInstanceOf(DOMException);
    expect(open).not.toHaveBeenCalled();
  });
});
