import type { ExtensionContributionId } from '@boaa/extension-contracts';
import {
  sourceCachePolicy,
  sourcePageFreshness,
  sourcePageTime,
  transientSourceFailure,
} from '../../external-sources/cache-policy';
import type { ExternalItemPage, ExternalSourceListInput } from '../../external-sources/contracts';
import type { DiscoverySession } from '../../features/discovery/discovery-session';

export interface SearchSource {
  id: string;
  title: string;
}
export interface SearchAnswer {
  id: string;
  source: SearchSource;
  title: string;
  parentRef?: string;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  page?: ExternalItemPage;
  error?: string;
  visibleOrder?: number;
  /** The source could not describe its child catalogs. Retry target discovery first. */
  retryTargets?: boolean;
}
const CACHE_LIMIT = 128;
const CACHE_BYTES = 4 * 1024 * 1024;
type CachedSource = { time: number; query: string; bytes: number; answers: readonly SearchAnswer[] };
const sessionCaches = new WeakMap<DiscoverySession, { sources: string; entries: Map<string, CachedSource> }>();

/** Searches and retries each connected catalog independently and cancels obsolete queries. */
export class SourceSearch {
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private groups: Map<string, SearchAnswer[]>;
  private state: { submitted: string; answers: readonly SearchAnswer[] };
  private generation = 0;
  private nextVisibleOrder = 0;
  private submittedIdentity?: string;
  private readonly cache: Map<string, CachedSource>;
  constructor(
    readonly session: DiscoverySession | undefined,
    readonly sources: readonly SearchSource[],
    restoredQuery?: string,
  ) {
    const sourceSet = JSON.stringify(
      sources.map(({ id, title }) => [id, title, session?.key(id, { browseMode: 'search' })]),
    );
    const retained = session && sessionCaches.get(session);
    this.cache = retained?.sources === sourceSet ? retained.entries : new Map();
    if (session) sessionCaches.set(session, { sources: sourceSet, entries: this.cache });
    this.groups = new Map(
      sources.map((source) => [source.id, [{ id: source.id, source, title: source.title, status: 'idle' }]]),
    );
    this.state = { submitted: '', answers: [...this.groups.values()].flat() };
    if (restoredQuery) this.start(restoredQuery, false);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish() {
    this.state = { ...this.state, answers: this.sources.flatMap((source) => this.groups.get(source.id) ?? []) };
    this.listeners.forEach((listener) => listener());
  }
  private stop() {
    this.generation++;
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }
  cancel = () => {
    this.stop();
    for (const [key, answers] of this.groups)
      this.groups.set(
        key,
        answers.map((answer) => (answer.status === 'loading' ? { ...answer, status: 'idle' } : answer)),
      );
    this.publish();
  };
  private policy(query: string) {
    const scope = this.session?.scope;
    return sourceCachePolicy(
      { browseMode: 'search', query },
      false,
      scope?.startsWith('hosted-account:') ? scope : undefined,
    );
  }
  submit = (query: string) => this.start(query, true);
  private start(query: string, fetchMissing: boolean) {
    const keys = this.sources.map((source) => this.cacheKey(source, query));
    const identity = JSON.stringify(keys);
    const now = Date.now();
    const policy = this.policy(query);
    const freshAnswer = (answer: SearchAnswer) =>
      answer.page &&
      now - sourcePageTime(answer.page, now) < sourcePageFreshness(policy.fresh, answer.page.items.length);
    const freshEntry = (entry: CachedSource) =>
      entry.answers.length ? entry.answers.every(freshAnswer) : now - entry.time < sourcePageFreshness(policy.fresh, 0);
    const entries = keys.map((key) => this.cache.get(key));
    const same = this.state.submitted === query && this.submittedIdentity === identity;
    if (
      same &&
      (this.requests.size ||
        entries.every((entry, i) => {
          const group = this.groups.get(this.sources[i].id) ?? [];
          return (
            entry &&
            freshEntry(entry) &&
            group.length === entry.answers.length &&
            group.every((answer, index) => answer.status === 'ready' && answer.page === entry.answers[index].page)
          );
        }))
    )
      return false;

    this.stop();
    this.submittedIdentity = identity;
    this.nextVisibleOrder = 0;
    this.state = { submitted: query, answers: [] };
    const missing: SearchSource[] = [];
    this.sources.forEach((source, index) => {
      const entry = entries[index];
      const key = keys[index];
      this.cache.delete(key);
      if (query && entry && policy.fresh > 0 && now - entry.time < policy.keep) {
        this.cache.set(key, entry);
        this.groups.set(
          source.id,
          entry.answers.map((answer) => ({
            ...answer,
            source,
            status: freshAnswer(answer) ? 'ready' : 'loading',
          })),
        );
        for (const answer of entry.answers)
          this.nextVisibleOrder = Math.max(this.nextVisibleOrder, (answer.visibleOrder ?? -1) + 1);
        if (freshEntry(entry)) return;
        if (!entry.answers.length)
          this.groups.set(source.id, [{ id: source.id, source, title: source.title, status: 'loading' }]);
      } else {
        this.groups.set(source.id, [
          { id: source.id, source, title: source.title, status: query ? 'loading' : 'idle' },
        ]);
      }
      if (query) missing.push(source);
    });
    this.publish();
    if (fetchMissing) for (const source of missing) void this.discover(source, this.generation);
    return true;
  }
  private cacheKey(source: SearchSource, query = this.state.submitted) {
    return this.session?.key(source.id, { browseMode: 'search', query }) ?? source.id;
  }
  private rememberSource(key: string, answers: SearchAnswer[]) {
    if (!answers.every((answer) => answer.status === 'ready')) return;
    this.cache.delete(key);
    const query = this.state.submitted;
    const policy = this.policy(query);
    if (!policy.fresh || answers.some((answer) => answer.page?.cache?.stale)) return;
    const now = Date.now();
    const time = answers.reduce(
      (min, answer) => (answer.page ? Math.min(min, sourcePageTime(answer.page, now)) : min),
      now,
    );
    if (now - time >= policy.keep) return;
    const serialized = JSON.stringify([key, answers]);
    if (serialized.length > CACHE_BYTES) return;
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > CACHE_BYTES) return;
    this.cache.set(key, { time, bytes, query, answers });
    let total = 0;
    for (const entry of this.cache.values()) total += entry.bytes;
    while (this.cache.size > CACHE_LIMIT || total > CACHE_BYTES) {
      const oldest = this.cache.entries().next().value!;
      total -= oldest[1].bytes;
      this.cache.delete(oldest[0]);
    }
  }
  forget(query?: string) {
    const normalize = (value: string) => value.trim().normalize('NFKC').toLowerCase();
    const matches = (value: string) => query === undefined || normalize(value) === normalize(query);
    if (matches(this.state.submitted)) this.submit('');
    for (const [key, entry] of this.cache) if (matches(entry.query)) this.cache.delete(key);
  }
  private canKeep(page: ExternalItemPage | undefined, error: unknown) {
    const policy = this.policy(this.state.submitted);
    return page && policy.fresh > 0 && Date.now() - sourcePageTime(page) < policy.keep && transientSourceFailure(error);
  }
  private input(answer: SearchAnswer): ExternalSourceListInput {
    return { browseMode: 'search', query: this.state.submitted, parentRef: answer.parentRef };
  }
  private async discover(source: SearchSource, generation: number, reload = false) {
    const session = this.session;
    if (!session) return;
    const previous = this.groups.get(source.id) ?? [];
    this.groups.set(
      source.id,
      previous.map((answer) =>
        answer.status === 'ready' && !reload ? answer : { ...answer, status: 'loading', error: undefined },
      ),
    );
    this.publish();
    const request = new AbortController();
    const identity = this.cacheKey(source);
    const key = `targets:${source.id}`;
    this.requests.get(key)?.abort();
    this.requests.set(key, request);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    try {
      const targets = await session.registry.getExternalSourceSearchTargets?.(
        source.id as ExtensionContributionId,
        session.context,
        signal,
      );
      signal.throwIfAborted();
      if (generation !== this.generation || identity !== this.cacheKey(source)) return;
      const targetsToLoad: SearchAnswer[] =
        targets === undefined
          ? [{ id: source.id, source, title: source.title, status: 'loading' }]
          : targets.map((target) => ({
              id: JSON.stringify([source.id, target.id]),
              source,
              title: target.title,
              parentRef: target.parentRef,
              status: 'loading',
            }));
      const answers: SearchAnswer[] = targetsToLoad.map((target) => {
        const prior = previous.find((answer) => answer.id === target.id && answer.parentRef === target.parentRef);
        return {
          ...target,
          status: !reload && prior?.status === 'ready' ? 'ready' : 'loading',
          page: prior?.page,
          visibleOrder: prior?.visibleOrder,
        };
      });
      const cached = this.cache.get(identity);
      if (
        cached &&
        (cached.answers.length !== answers.length ||
          answers.some(
            (answer, i) => answer.id !== cached.answers[i].id || answer.parentRef !== cached.answers[i].parentRef,
          ))
      )
        this.cache.delete(identity);
      this.groups.set(source.id, answers);
      this.publish();
      this.rememberSource(identity, answers);
      for (const answer of answers) if (answer.status === 'loading') void this.load(answer, generation, reload);
    } catch (error) {
      if (!request.signal.aborted && generation === this.generation && identity === this.cacheKey(source)) {
        const retained = previous.filter((answer) => this.canKeep(answer.page, error));
        if (!retained.length) this.cache.delete(identity);
        const failed = retained.length ? retained : [{ id: source.id, source, title: source.title }];
        this.groups.set(
          source.id,
          failed.map((answer) => ({
            ...answer,
            status: 'failed',
            retryTargets: true,
            error: error instanceof Error ? error.message : 'search_failed',
          })),
        );
        this.publish();
      }
    } finally {
      if (this.requests.get(key) === request) this.requests.delete(key);
    }
  }
  private async load(answer: SearchAnswer, generation: number, reload = false) {
    const session = this.session;
    if (!session) return;
    this.requests.get(answer.id)?.abort();
    const request = new AbortController();
    this.requests.set(answer.id, request);
    const input = this.input(answer);
    const identity = session.key(answer.source.id, input);
    const sourceKey = this.cacheKey(answer.source);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const update = (next: Partial<SearchAnswer>) => {
      if (request.signal.aborted || generation !== this.generation || identity !== session.key(answer.source.id, input))
        return;
      const answers = (this.groups.get(answer.source.id) ?? []).map((value) => {
        if (value.id !== answer.id) return value;
        const visibleOrder = value.visibleOrder ?? (next.page?.items.length ? this.nextVisibleOrder++ : undefined);
        return { ...value, ...next, visibleOrder };
      });
      this.groups.set(answer.source.id, answers);
      if (next.status === 'ready') this.rememberSource(sourceKey, answers);
      this.publish();
    };
    update({ status: 'loading', error: undefined });
    try {
      const status = session.registry.getExternalSourceStatus(
        answer.source.id as ExtensionContributionId,
        session.context,
      );
      const page = await session.registry.listExternalSource(
        answer.source.id as ExtensionContributionId,
        session.context,
        { ...input, accountConnectionId: status.accountConnectionId, ...(reload && { cacheMode: 'reload' as const }) },
        signal,
      );
      signal.throwIfAborted();
      update({ page: { ...page, cache: { ...page.cache, fetchedAt: sourcePageTime(page) } }, status: 'ready' });
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation || identity !== session.key(answer.source.id, input))
        return;
      const keepPage = this.canKeep(answer.page, error);
      if (!keepPage) this.cache.delete(sourceKey);
      update({
        page: keepPage ? answer.page : undefined,
        status: 'failed',
        error: error instanceof Error ? error.message : 'search_failed',
      });
    } finally {
      if (this.requests.get(answer.id) === request) this.requests.delete(answer.id);
    }
  }
  resume() {
    if (this.state.submitted) this.submit(this.state.submitted);
  }
  retry = (answer: SearchAnswer) => {
    if (!this.state.submitted || !this.state.answers.includes(answer)) return;
    if (this.submittedIdentity !== JSON.stringify(this.sources.map((source) => this.cacheKey(source)))) {
      this.submit(this.state.submitted);
      return;
    }
    this.cache.delete(this.cacheKey(answer.source));
    if (answer.retryTargets || (answer.id === answer.source.id && !answer.page))
      void this.discover(answer.source, this.generation, true);
    else void this.load(answer, this.generation, true);
  };
}
