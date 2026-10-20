/** useDiscoverySection({ section, source, session, query, refresh, positions }) manages a discovery rail.
 * Returns page/candidate/loading/error/unsupported/unavailable, title/eyebrow, input,
 * refreshSection (apply candidate or retry; undefined when unavailable),
 * ref (near-observed section), rail (scroll-restored rail), near and itemOpenArgs(item).
 * itemOpenArgs returns [sourceId, input, title] for the existing open callback.
 */
import { useEffect, useRef, useState } from 'react';
import { useNear } from './useDiscoveryCover';
import type { ExternalItemPage, ExternalItemSummary, ExternalSourceListInput } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../external-sources/useExternalSourceController';
import type { DiscoverySession } from './discovery-session';
import type { DiscoverySection as Section } from './discovery-config';
export interface DiscoverySectionStateInput {
  section: Section;
  source?: ExternalSourceView;
  session: DiscoverySession;
  query: string;
  refresh: number;
  positions: Map<string, number>;
}
export function useDiscoverySection({
  section,
  source,
  session,
  query,
  refresh,
  positions,
}: DiscoverySectionStateInput) {
  const ref = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  const input: ExternalSourceListInput = {
    parentRef: section.parentRef,
    browseMode: query ? 'search' : section.mode,
    query: query || undefined,
    filters: section.filters,
  };
  const descriptor = session.registry
    .getExternalSources()
    .find((entry) => entry.descriptor.id === section.sourceId)?.descriptor;
  const unsupported =
    source?.kind === 'cloud_file'
      ? '파일 소스입니다. 폴더 보기에서 파일을 찾아보세요.'
      : descriptor && !descriptor.capabilities.includes(query ? 'search' : 'browse')
        ? query
          ? '이 소스는 검색을 지원하지 않습니다.'
          : '이 소스는 목록 탐색을 지원하지 않습니다. 검색을 이용해 주세요.'
        : undefined;
  const inputKey = JSON.stringify(input);
  const [page, setPage] = useState<ExternalItemPage | undefined>(() => session.peek(section.sourceId, input)?.page);
  const [candidate, setCandidate] = useState<ExternalItemPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const previous = useRef({ refresh, retry });
  const latest = useRef({ input, page });
  latest.current = { input, page };
  useEffect(() => {
    if (!near || unsupported || source?.connection.state !== 'connected') return;
    let active = true;
    const force = previous.current.refresh !== refresh || previous.current.retry !== retry;
    previous.current = { refresh, retry };
    setLoading(true);
    setError('');
    const fetchPage = async () => {
      const saved = await session.restore(section.sourceId, latest.current.input);
      if (active && saved && !latest.current.page) {
        setPage(saved);
        latest.current.page = saved;
      }
      if (!active) return undefined;
      if (section.filterSignature) {
        const schema = await session.schema(
          section.sourceId,
          { parentRef: section.parentRef, browseMode: section.mode },
          force,
        );
        if (JSON.stringify(schema.browse?.filters ?? []) !== section.filterSignature)
          throw new Error('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
      }
      return session.list(section.sourceId, latest.current.input, force);
    };
    void fetchPage()
      .then((result) => {
        if (!active || !result) return;
        if (result.cache?.stale) setError('연결을 확인하지 못했습니다.');
        if (result.browse && !result.browse.availableModes.includes(latest.current.input.browseMode ?? section.mode)) {
          setError('이 소스가 해당 목록을 지원하지 않습니다. 다른 목록을 선택해 주세요.');
          setPage(undefined);
          return;
        }
        if (section.filterSignature && JSON.stringify(result.browse?.filters ?? []) !== section.filterSignature) {
          setError('소스의 분류가 변경되었습니다. 전체 보기에서 분류를 다시 저장해 주세요.');
          setPage(undefined);
          return;
        }
        if (latest.current.page && !force && JSON.stringify(result.items) !== JSON.stringify(latest.current.page.items))
          setCandidate(result);
        else {
          setPage(result);
          setCandidate(undefined);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '목록을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    near,
    unsupported,
    session,
    section.sourceId,
    section.parentRef,
    section.mode,
    section.filterSignature,
    inputKey,
    source?.connection.state,
    query,
    refresh,
    retry,
  ]);
  useEffect(() => {
    const node = rail.current;
    if (!node || !page) return;
    node.scrollLeft = positions.get(section.id) ?? 0;
    const save = () => positions.set(section.id, node.scrollLeft);
    node.addEventListener('scroll', save, { passive: true });
    return () => node.removeEventListener('scroll', save);
  }, [page, positions, section.id]);
  const title = query
    ? `${source?.title ?? '소스'} · 검색 결과`
    : section.title ||
      `${source?.title ?? '사용할 수 없는 소스'} · ${section.mode === 'popular' ? '인기' : '최신 업데이트'}`;
  const unavailable = !source || source.connection.state !== 'connected';
  const eyebrow = section.title ? source?.title : '작품 탐색';
  const refreshSection =
    !unsupported && !unavailable
      ? () => {
          if (candidate && !error) {
            setPage(candidate);
            setCandidate(undefined);
          } else setRetry((v) => v + 1);
        }
      : undefined;
  const itemOpenArgs = (item: ExternalItemSummary): [string, ExternalSourceListInput, string | undefined] => [
    section.sourceId,
    item.navigationRef ? { parentRef: item.navigationRef } : input,
    item.navigationRef ? item.title : undefined,
  ];
  return {
    ref,
    rail,
    near,
    input,
    page,
    candidate,
    loading,
    error,
    unsupported,
    unavailable,
    title,
    eyebrow,
    refreshSection,
    itemOpenArgs,
  };
}
