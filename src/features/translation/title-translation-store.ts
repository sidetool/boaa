import {
  shouldTranslateTitle,
  DEFAULT_TRANSLATION_SETTINGS,
  type TitleTranslationResponse,
  type TranslationConfiguration,
  type TranslatedTitle,
} from '../../translation/contracts';

type Entry = { result?: TranslatedTitle; nextAt: number; failures: number };
type Transport = {
  configuration(signal: AbortSignal): Promise<TranslationConfiguration>;
  translate(titles: string[], signal: AbortSignal): Promise<TitleTranslationResponse>;
};
/** One scheduler per account API, shared by all visible cards. No title/secret is persisted in the browser. */
export class TitleTranslationStore {
  private configuration?: TranslationConfiguration;
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<() => void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private generation = 0;
  private checkedAt = 0;
  constructor(private readonly transport: Transport) {}

  get(title: string): string {
    if (!this.configuration?.settings.enabled || !this.configuration.settings.translateTitles) return title;
    return this.entries.get(title)?.result?.translated ?? title;
  }
  subscribe(title: string, listener: () => void): () => void {
    if (!title.trim() || title.length > 500) return () => undefined;
    const first = this.listeners.size === 0;
    const callbacks = this.listeners.get(title) ?? new Set();
    callbacks.add(listener);
    this.listeners.set(title, callbacks);
    if (!this.entries.has(title)) this.entries.set(title, { nextAt: 0, failures: 0 });
    if (first) {
      globalThis.addEventListener?.('focus', this.refresh);
      globalThis.document?.addEventListener?.('visibilitychange', this.visibilityChanged);
      // Refresh another tab's settings when returning to a list, without per-card GETs.
      if (Date.now() - this.checkedAt > 60000) this.invalidate();
    }
    this.schedule(250);
    return () => {
      callbacks.delete(listener);
      if (!callbacks.size) this.listeners.delete(title);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.request?.abort();
        globalThis.removeEventListener?.('focus', this.refresh);
        globalThis.document?.removeEventListener?.('visibilitychange', this.visibilityChanged);
      }
      this.prune();
    };
  }
  dispose() {
    this.reset();
    this.configuration = undefined;
    this.notify();
    this.listeners.clear();
    globalThis.removeEventListener?.('focus', this.refresh);
    globalThis.document?.removeEventListener?.('visibilitychange', this.visibilityChanged);
  }
  private refresh = () => this.invalidate();
  private visibilityChanged = () => {
    if (globalThis.document?.visibilityState === 'hidden') {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.request?.abort();
    } else this.schedule(250);
  };
  configure(configuration: TranslationConfiguration) {
    this.reset();
    this.configuration = configuration;
    this.checkedAt = Date.now();
    this.notify();
    this.schedule(250);
  }
  invalidate() {
    this.reset();
    this.configuration = undefined;
    this.checkedAt = 0;
    this.notify();
    this.schedule(250);
  }
  private reset() {
    this.generation++;
    this.request?.abort();
    this.entries.clear();
    for (const title of this.listeners.keys()) this.entries.set(title, { nextAt: 0, failures: 0 });
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private notify() {
    for (const callbacks of this.listeners.values()) for (const callback of callbacks) callback();
  }
  private prune() {
    for (const title of this.entries.keys()) {
      if (this.entries.size <= 1000) break;
      if (!this.listeners.has(title)) this.entries.delete(title);
    }
  }
  private schedule(delay: number) {
    if (!this.listeners.size || this.timer || globalThis.document?.visibilityState === 'hidden') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }
  private async flush() {
    if (!this.listeners.size || this.request) return;
    const controller = new AbortController();
    this.request = controller;
    const generation = this.generation;
    const current = () => !controller.signal.aborted && generation === this.generation;
    let batch: string[] = [];
    try {
      if (!this.configuration) {
        const configuration = await this.transport.configuration(controller.signal);
        if (!current()) return;
        this.configuration = configuration;
        this.checkedAt = Date.now();
        this.notify();
      }
      const { settings } = this.configuration;
      if (!settings.enabled || !settings.translateTitles) return;
      // Earliest-due first: a long-running batch never blocks newly visible titles.
      batch = [...this.listeners.keys()]
        .filter((title) => shouldTranslateTitle(title, settings.targetLanguage))
        .filter((title) => (this.entries.get(title)?.nextAt ?? 0) <= Date.now())
        .sort((a, b) => (this.entries.get(a)?.nextAt ?? 0) - (this.entries.get(b)?.nextAt ?? 0))
        .slice(0, 24);
      if (!batch.length) return;
      const response = await this.transport.translate(batch, controller.signal);
      if (!current()) return;
      const results = new Map(response.titles.map((result) => [result.original, result]));
      for (const title of batch) {
        const result = results.get(title);
        const pending = result && ['queued', 'running'].includes(result.status);
        this.entries.set(title, { result, failures: 0, nextAt: pending ? Date.now() + 2000 : Infinity });
        for (const callback of this.listeners.get(title) ?? []) callback();
      }
    } catch {
      if (!current()) return;
      if (!this.configuration) {
        // Old servers/authorization/network failures keep original titles. Retry on focus/re-entry.
        this.configuration = {
          settings: { ...DEFAULT_TRANSLATION_SETTINGS },
          revision: 0,
          credentials: {},
          usedCharacters: 0,
        };
        this.checkedAt = Date.now();
      }
      for (const title of batch) {
        const failures = (this.entries.get(title)?.failures ?? 0) + 1;
        this.entries.set(title, { failures, nextAt: failures < 3 ? Date.now() + 5000 * failures : Infinity });
      }
    } finally {
      this.request = undefined;
      this.prune();
      if (generation !== this.generation || controller.signal.aborted) this.schedule(250);
      else if (this.configuration?.settings.enabled && this.configuration.settings.translateTitles) {
        const next = Math.min(
          ...[...this.listeners.keys()]
            .filter((title) => shouldTranslateTitle(title, this.configuration!.settings.targetLanguage))
            .map((title) => this.entries.get(title)?.nextAt ?? 0),
        );
        if (Number.isFinite(next)) this.schedule(Math.max(250, next - Date.now()));
      }
    }
  }
}
