import { sourceRowInput } from './source-row';
import {
  externalItemKeyId,
  type ExternalItemPage,
  type ExternalSourceListInput,
} from '../../external-sources/contracts';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import type { DiscoveryConfig, DiscoverySection } from '../../features/discovery/discovery-config';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import type { HomeRowConfig, HomeRowView, UiNextHomeAdapter } from './contract';

export interface HomeDiscoverySection {
  /** Opaque list identity carried by the existing editor and synced discoveryTabId field. */
  id: string;
  tabId: string;
  tabTitle: string;
  section: DiscoverySection;
  sourceLabel: string;
  title: string;
}
export interface HomeDiscoveryAdapter {
  rowBuilder?: UiNextHomeAdapter['rowBuilder'];
  /** Increments when a shared row finishes loading or publishes cached data. */
  revision?: number;
  sections: readonly HomeDiscoverySection[];
  row(config: HomeRowConfig): HomeRowView;
}
export function homeDiscoverySections(
  config: DiscoveryConfig,
  sources: ExternalSourceController['sources'],
): HomeDiscoverySection[] {
  return config.tabs
    .filter((tab) => !tab.hidden)
    .flatMap((tab) =>
      tab.sections.map((section) => {
        const sourceLabel = sources.find((source) => source.id === section.sourceId)?.title ?? '사용할 수 없는 소스';
        return {
          id: JSON.stringify([tab.id, section.id]),
          tabId: tab.id,
          tabTitle: tab.title,
          section,
          sourceLabel,
          title: section.title || `${sourceLabel} · ${section.mode === 'popular' ? '인기' : '최신'}`,
        };
      }),
    );
}
export function homeSourceSection(
  config: HomeRowConfig,
  sources: ExternalSourceController['sources'],
): HomeDiscoverySection | undefined {
  if (config.kind !== 'source' || !config.section) return;
  const source = sources.find((source) => source.id === config.section?.sourceId);
  if (!source) return;
  return {
    id: config.id,
    tabId: '',
    tabTitle: '',
    sourceLabel: source.title,
    title: config.section.title,
    section: { ...config.section, id: `home-source:${config.id}` },
  };
}

interface Entry {
  started: boolean;
  pending: boolean;
  page?: ExternalItemPage;
  error?: string;
}
/** UI-free lazy row store. It shares the app-owned session's cache, per-source queue and concurrency limits. */
export class HomeDiscoveryLoader {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(readonly session: DiscoverySession) {}
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
  row(
    config: HomeRowConfig,
    list: HomeDiscoverySection,
    sources: ExternalSourceController,
    open: (source: string, input: ExternalSourceListInput, title?: string) => void,
    openAll: (tabId: string) => void,
    openSource?: (section: DiscoverySection) => void,
  ): HomeRowView {
    const section = list.section;
    const input = sourceRowInput(section);
    const source = sources.sources.find((candidate) => candidate.id === section.sourceId);
    const key = JSON.stringify([section, this.session.key(section.sourceId, input)]);
    const validate = (page: ExternalItemPage) => {
      if (page.browse && !page.browse.availableModes.includes(input.browseMode!))
        throw new Error('이 소스가 해당 목록을 지원하지 않습니다. 다른 목록을 선택해 주세요.');
      if (section.filterSignature && JSON.stringify(page.browse?.filters ?? []) !== section.filterSignature)
        throw new Error('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
    };
    const validCachedPage = (page: ExternalItemPage | undefined) => {
      if (!page) return;
      try {
        validate(page);
        return page;
      } catch {
        // An incompatible cached page must not appear while the live schema is checked.
        return undefined;
      }
    };
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        started: false,
        pending: false,
        page: validCachedPage(this.session.peek(section.sourceId, input)?.page),
      };
      this.entries.set(key, entry);
    }
    const current = entry;
    const load = (force: boolean) => {
      if (current.pending || (!force && current.started)) return;
      current.started = true;
      current.pending = true;
      current.error = undefined;
      this.changed();
      void (async () => {
        try {
          if (!source || source.connection.state !== 'connected') throw new Error('소스 연결을 확인해 주세요.');
          const descriptor = this.session.registry
            .getExternalSources()
            .find((entry) => entry.descriptor.id === section.sourceId)?.descriptor;
          if (source.kind === 'cloud_file') throw new Error('파일 소스입니다. 폴더 보기에서 파일을 찾아보세요.');
          if (descriptor && !descriptor.capabilities.includes('browse'))
            throw new Error('이 소스는 목록 탐색을 지원하지 않습니다. 검색을 이용해 주세요.');
          const saved = validCachedPage(await this.session.restore(section.sourceId, input));
          if (saved) {
            current.page = saved;
            this.changed();
          }
          if (section.filterSignature) {
            const schema = await this.session.schema(
              section.sourceId,
              { parentRef: section.parentRef, browseMode: section.filters?.length ? 'popular' : section.mode },
              force,
            );
            validate(schema);
          }
          const page = await this.session.list(section.sourceId, input, force);
          validate(page);
          current.page = page;
          if (page.cache?.stale) current.error = '연결을 확인하지 못했습니다.';
        } catch (error) {
          current.error = error instanceof Error ? error.message : '목록을 불러오지 못했습니다.';
        } finally {
          current.pending = false;
          this.changed();
        }
      })();
    };
    return {
      config,
      title: list.title,
      eyebrow: list.sourceLabel,
      ranked: section.mode === 'popular' && !section.filters?.length,
      status: current.page ? 'ready' : current.error ? 'failed' : 'loading',
      error: current.error,
      requestLoad: () => load(false),
      retry: () => load(true),
      openAll:
        config.kind === 'source'
          ? () => (openSource ? openSource(section) : open(section.sourceId, input, section.title))
          : () => openAll(list.tabId),
      items: (current.page?.items ?? []).slice(0, 20).map((item) => ({
        kind: 'discovery',
        key: externalItemKeyId(item.key),
        work: {
          id: externalItemKeyId(item.key),
          title: item.title,
          translateTitle: item.kind === 'work',
          author: item.author,
          thumbnailUrl: item.thumbnailUrl ?? (item.coverRef ? this.session.peekCover?.(item.coverRef) : undefined),
          subline: item.subtitle,
          loadCover: item.coverRef ? (signal) => this.session.cover(item.coverRef!, signal) : undefined,
          owned: sources.libraryWorks.some(
            (work) =>
              work.connectorId === item.key.connectorId &&
              work.accountConnectionId === item.key.accountConnectionId &&
              work.collectionRemoteId === item.key.remoteId,
          ),
          open: () =>
            open(
              section.sourceId,
              item.navigationRef ? { parentRef: item.navigationRef } : input,
              item.navigationRef ? item.title : undefined,
            ),
        },
      })),
    };
  }
}
