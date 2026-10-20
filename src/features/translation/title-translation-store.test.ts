import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  shouldTranslateTitle,
  validateTranslationSettings,
  type TranslationConfiguration,
  type TitleTranslationResponse,
} from '../../translation/contracts';
import { TitleTranslationStore } from './title-translation-store';
const configuration = (enabled = true): TranslationConfiguration => ({
  settings: { ...DEFAULT_TRANSLATION_SETTINGS, enabled, translateTitles: enabled, model: 'synthetic' },
  revision: 1,
  credentials: { gemini: { saved: true } },
  usedCharacters: 0,
});
function fixture(config = configuration()) {
  const transport = {
    configuration: vi.fn(async () => config),
    translate: vi.fn(async (titles: string[]): Promise<TitleTranslationResponse> => ({
      titles: titles.map((original) => ({ original, translated: `번역 ${original}`, status: 'complete' })),
    })),
  };
  const store = new TitleTranslationStore(transport);
  stores.push(store);
  return { store, transport };
}
const stores: TitleTranslationStore[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('shared visible-title batching', () => {
  it('collects cards in one request, deduplicates and skips target-language/non-letter titles', async () => {
    const { store, transport } = fixture();
    for (const title of ['First title', 'Second title', 'First title', '한국어 제목', '123'])
      store.subscribe(title, vi.fn());
    expect(store.get('First title')).toBe('First title');
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.configuration).toHaveBeenCalledTimes(1);
    expect(transport.translate).toHaveBeenCalledTimes(1);
    expect(transport.translate.mock.calls[0][0]).toEqual(['First title', 'Second title']);
    expect(store.get('First title')).toBe('번역 First title');
    store.subscribe('Second title', vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.translate).toHaveBeenCalledTimes(1);
  });
  it('limits batch size, fetches only subscribed titles and sends no paid request while disabled', async () => {
    const { store, transport } = fixture(configuration(false));
    const stops = Array.from({ length: 30 }, (_, i) => store.subscribe(`Story ${i}`, vi.fn()));
    stops[0]();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.translate).not.toHaveBeenCalled();
    store.configure(configuration());
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.translate.mock.calls.map(([titles]) => titles.length)).toEqual([24, 5]);
    expect(transport.translate.mock.calls.flatMap(([titles]) => titles)).not.toContain('Story 0');
  });
  it('discards old results after disabling and stops polls when the last visible card leaves', async () => {
    const { store, transport } = fixture();
    let finish!: (response: TitleTranslationResponse) => void;
    transport.translate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stop = store.subscribe('Story', vi.fn());
    await vi.advanceTimersByTimeAsync(250);
    store.configure(configuration(false));
    finish({ titles: [{ original: 'Story', translated: 'Late', status: 'complete' }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(store.get('Story')).toBe('Story');
    store.configure(configuration());
    transport.translate.mockResolvedValue({ titles: [{ original: 'Story', status: 'queued' }] });
    await vi.advanceTimersByTimeAsync(250);
    stop();
    const calls = transport.translate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(transport.translate).toHaveBeenCalledTimes(calls);
  });
  it('does not repeat failed jobs and keeps independent account stores separate', async () => {
    const a = fixture();
    const b = fixture();
    a.transport.translate.mockResolvedValue({ titles: [{ original: 'Story', status: 'failed' }] });
    a.store.subscribe('Story', vi.fn());
    b.store.subscribe('Story', vi.fn());
    await vi.advanceTimersByTimeAsync(10000);
    expect(a.transport.translate).toHaveBeenCalledTimes(1);
    expect(a.store.get('Story')).toBe('Story');
    expect(b.store.get('Story')).toBe('번역 Story');
  });
  it('bounds transport retries instead of spinning on a broken server', async () => {
    const { store, transport } = fixture();
    transport.translate.mockRejectedValue(new Error('offline'));
    store.subscribe('Story', vi.fn());
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.translate).toHaveBeenCalledTimes(3);
    expect(store.get('Story')).toBe('Story');
  });
  it('accepts old settings with titles off and drops the old daily cap', () => {
    const { translateTitles: _old, ...old } = DEFAULT_TRANSLATION_SETTINGS;
    const result = validateTranslationSettings({ ...old, dailyCharacters: 1 });
    expect(result.translateTitles).toBe(false);
    expect(result).not.toHaveProperty('dailyCharacters');
    expect(shouldTranslateTitle('短い物語', 'ko')).toBe(true);
    expect(shouldTranslateTitle('한국어 제목', 'ko')).toBe(false);
    expect(shouldTranslateTitle('123', 'ko')).toBe(false);
  });
  it('pauses title requests while the tab is hidden and resumes the same batch on return', async () => {
    const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    vi.stubGlobal('document', document);
    const { store, transport } = fixture();
    store.subscribe('A visible story', vi.fn());
    await vi.advanceTimersByTimeAsync(10000);
    expect(transport.translate).not.toHaveBeenCalled();
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.translate).toHaveBeenCalledTimes(1);
  });
});
