import type { HomeRowConfig, HomeRowView } from './contract';
import { openSearch } from '../search/route';

export interface HomePluginSection {
  pluginId: string;
  installationId: string;
  digest: string;
  revision: number;
  pluginName: string;
  section: { id: string; title: string; description?: string };
}
export interface HomePluginFeed {
  items: Array<{ id: string; title: string; author?: string; rank?: number; coverUrl?: string; searchQuery?: string }>;
  asOf?: string;
  ttlSeconds?: number;
}
export interface HomePluginService {
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
  homeSections(): Promise<HomePluginSection[]>;
  homeFeed(pluginId: string, sectionId: string, signal?: AbortSignal): Promise<HomePluginFeed>;
  homeCover(pluginId: string, sectionId: string, url: string, signal?: AbortSignal): Promise<string | undefined>;
}
export interface HomePluginAdapter {
  revision?: number;
  sections: readonly HomePluginSection[];
  row(config: HomeRowConfig): HomeRowView;
}
export const pluginHomeRowId = (pluginId: string, sectionId: string) => `plugin:${pluginId}:${sectionId}`;
const identity = (section: HomePluginSection) =>
  JSON.stringify([section.installationId, section.digest, section.revision]);
interface Entry {
  section: HomePluginSection;
  page?: HomePluginFeed;
  fetchedAt?: number;
  refreshAt?: number;
  error?: string;
  operation?: AbortController;
}

/** Account-session memory only. Package changes revoke pending work and cached artwork access. */
export class HomePluginLoader {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  private disposed = false;
  constructor(private readonly service: HomePluginService) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private changed() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  get sections() {
    return [...this.entries.values()].map((entry) => entry.section);
  }
  resume() {
    this.disposed = false;
  }
  async sync() {
    const generation = ++this.generation;
    for (const entry of this.entries.values()) {
      entry.operation?.abort();
      entry.operation = undefined;
    }
    try {
      const sections = await this.service.homeSections();
      if (this.disposed || generation !== this.generation) return;
      const next = new Map<string, Entry>();
      for (const section of sections) {
        const key = pluginHomeRowId(section.pluginId, section.section.id);
        const previous = this.entries.get(key);
        next.set(
          key,
          previous && identity(previous.section) === identity(section) ? { ...previous, section } : { section },
        );
      }
      this.entries = next;
    } catch {
      if (this.disposed || generation !== this.generation) return;
      for (const entry of this.entries.values()) {
        entry.error = '플러그인 상태를 확인하지 못했어요. 다시 시도해 주세요.';
        entry.refreshAt = Date.now() + 60_000;
      }
    }
    this.changed();
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.entries.forEach((entry) => entry.operation?.abort());
    this.entries.clear();
    this.listeners.clear();
  }
  row(config: HomeRowConfig): HomeRowView {
    const key = pluginHomeRowId(config.pluginId!, config.pluginSectionId!);
    const entry = this.entries.get(key);
    if (!entry)
      return { config, title: '플러그인 목록', status: 'failed', error: '사용할 수 없는 플러그인이에요.', items: [] };
    const { section } = entry;
    const current = () => !this.disposed && this.entries.get(key) === entry;
    const load = (force: boolean) => {
      if (!current() || entry.operation || (!force && entry.refreshAt && entry.refreshAt > Date.now())) return;
      const generation = this.generation;
      const operation = new AbortController();
      entry.operation = operation;
      entry.error = undefined;
      this.changed();
      void this.service
        .homeFeed(section.pluginId, section.section.id, operation.signal)
        .then((page) => {
          if (!current() || operation.signal.aborted || generation !== this.generation) return;
          entry.page = page;
          entry.fetchedAt = Date.now();
          entry.refreshAt = Date.now() + Math.max(60, Math.min(page.ttlSeconds ?? 1800, 86400)) * 1000;
        })
        .catch(() => {
          if (!current() || operation.signal.aborted || generation !== this.generation) return;
          entry.error = '목록을 새로 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.';
          entry.refreshAt = Date.now() + 60_000;
        })
        .finally(() => {
          if (!current() || entry.operation !== operation) return;
          entry.operation = undefined;
          this.changed();
        });
    };
    return {
      config,
      title: section.section.title,
      eyebrow: section.pluginName,
      ranked: entry.page?.items.some((item) => item.rank !== undefined),
      status: entry.page ? 'ready' : entry.error ? 'failed' : 'loading',
      loadKey: key + identity(section) + this.generation,
      refreshAt: entry.refreshAt,
      refreshing: Boolean(entry.operation),
      updatedAt: entry.page?.asOf ? Date.parse(entry.page.asOf) : entry.fetchedAt,
      stale: Boolean(entry.page && entry.error),
      error: entry.error,
      requestLoad: () => load(false),
      retry: () => load(true),
      items: (entry.page?.items ?? []).map((item) => ({
        kind: 'discovery',
        key: `${key}:${item.id}`,
        work: {
          id: `${key}:${item.id}`,
          title: item.title,
          author: item.author,
          rank: item.rank,
          coverKey: identity(section) + (item.coverUrl ?? ''),
          translateTitle: false,
          actionLabel: '검색',
          loadCover: item.coverUrl
            ? (signal) =>
                current()
                  ? this.service.homeCover(section.pluginId, section.section.id, item.coverUrl!, signal)
                  : Promise.resolve(undefined)
            : undefined,
          open: () => {
            if (current()) openSearch(item.searchQuery?.trim() || item.title);
          },
        },
      })),
    };
  }
}
