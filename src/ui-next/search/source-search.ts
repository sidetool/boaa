import type { ExtensionContributionId } from '@boaa/extension-contracts';
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
}
/** Independent, abortable first pages. Does not borrow the discovery session's non-cancellable list queue. */
export class SourceSearch {
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private groups: Map<string, SearchAnswer[]>;
  private state: { submitted: string; answers: readonly SearchAnswer[] };
  private generation = 0;
  constructor(
    readonly session: DiscoverySession | undefined,
    readonly sources: readonly SearchSource[],
  ) {
    this.groups = new Map(
      sources.map((source) => [source.id, [{ id: source.id, source, title: source.title, status: 'idle' }]]),
    );
    this.state = { submitted: '', answers: [...this.groups.values()].flat() };
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
  submit = (query: string) => {
    this.stop();
    this.state = { submitted: query, answers: [] };
    for (const source of this.sources)
      this.groups.set(source.id, [{ id: source.id, source, title: source.title, status: query ? 'loading' : 'idle' }]);
    this.publish();
    if (query) for (const source of this.sources) void this.discover(source, this.generation);
  };
  private input(answer: SearchAnswer): ExternalSourceListInput {
    return { browseMode: 'search', query: this.state.submitted, parentRef: answer.parentRef };
  }
  private async discover(source: SearchSource, generation: number) {
    const session = this.session;
    if (!session) return;
    this.groups.set(source.id, [{ id: source.id, source, title: source.title, status: 'loading' }]);
    this.publish();
    const request = new AbortController();
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
      if (generation !== this.generation) return;
      const answers: SearchAnswer[] =
        targets === undefined
          ? [{ id: source.id, source, title: source.title, status: 'loading' }]
          : targets.map((target) => ({
              id: JSON.stringify([source.id, target.id]),
              source,
              title: target.title,
              parentRef: target.parentRef,
              status: 'loading',
            }));
      this.groups.set(source.id, answers);
      this.publish();
      for (const answer of answers) void this.load(answer, generation);
    } catch (error) {
      if (!request.signal.aborted && generation === this.generation) {
        this.groups.set(source.id, [
          {
            id: source.id,
            source,
            title: source.title,
            status: 'failed',
            error: error instanceof Error ? error.message : 'search_failed',
          },
        ]);
        this.publish();
      }
    } finally {
      if (this.requests.get(key) === request) this.requests.delete(key);
    }
  }
  private async load(answer: SearchAnswer, generation: number) {
    const session = this.session;
    if (!session) return;
    this.requests.get(answer.id)?.abort();
    const request = new AbortController();
    this.requests.set(answer.id, request);
    const input = this.input(answer);
    const identity = session.key(answer.source.id, input);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const update = (next: Partial<SearchAnswer>) => {
      if (request.signal.aborted || generation !== this.generation || identity !== session.key(answer.source.id, input))
        return;
      this.groups.set(
        answer.source.id,
        (this.groups.get(answer.source.id) ?? []).map((value) =>
          value.id === answer.id ? { ...value, ...next } : value,
        ),
      );
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
        { ...input, accountConnectionId: status.accountConnectionId },
        signal,
      );
      signal.throwIfAborted();
      update({ page, status: 'ready' });
    } catch (error) {
      update({ status: 'failed', error: error instanceof Error ? error.message : 'search_failed' });
    } finally {
      if (this.requests.get(answer.id) === request) this.requests.delete(answer.id);
    }
  }
  retry = (answer: SearchAnswer) => {
    if (!this.state.submitted || !this.state.answers.includes(answer)) return;
    if (answer.id === answer.source.id && answer.status === 'failed' && !answer.page)
      void this.discover(answer.source, this.generation);
    else void this.load(answer, this.generation);
  };
}
