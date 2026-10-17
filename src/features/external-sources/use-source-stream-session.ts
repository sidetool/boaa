import { preferTextLibrary } from './source-read-mode';
import { ownedSourceStreamPort } from './source-owned-stream-port';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import { externalItemKeyId, type ExternalItemPage, type ExternalItemSummary } from '../../external-sources/contracts';
import { isTextStream, type SourceReadingPort } from '../../external-sources/source-text-stream';
import { cachePageId, saveSourceCache, storedSourcePage } from '../../external-sources/cached-page';
import type { SourceReleasePreference } from '../../external-sources/source-user-state';
import { completeSeriesCatalog } from './complete-series-catalog';
import { useSourceCommandScope } from './use-source-command-scope';
import type {
  ExternalSourceController,
  ExternalSourceItemView,
  UseExternalSourceControllerOptions,
} from './external-source-controller-contract';

type StreamOptions = Pick<
  UseExternalSourceControllerOptions,
  | 'registry'
  | 'state'
  | 'settingsScope'
  | 'extensionRevision'
  | 'hostContext'
  | 'notify'
  | 'assets'
  | 'getParagraphPage'
  | 'getNovel'
  | 'listChapters'
  | 'saveTextPosition'
  | 'saveStreamPosition'
>;
export function useSourceStreamSession(input: {
  options: StreamOptions;
  open: boolean;
  openLibrary?(item: ExternalSourceItemView): Promise<void>;
  onStreamStarted?(item: ExternalSourceItemView): void;
  items(): readonly ExternalItemSummary[];
}) {
  const { owner, capture } = useSourceCommandScope(input.options);
  const latest = useRef(input);
  latest.current = input;
  const optionsRef = useRef(input.options);
  optionsRef.current = input.options;
  const resume = useRef<AbortController>();
  const [snapshot, setStreaming] = useState<{
    owner: typeof owner;
    value: ExternalSourceController['streaming'];
    connectionKey: string;
  }>();
  const streaming = snapshot?.owner === owner ? snapshot.value : undefined;
  const cancelResume = useCallback(() => {
    if (capture()()) resume.current?.abort();
  }, [capture]);
  const startResume = useCallback(() => {
    const abort = new AbortController();
    if (!capture()()) {
      abort.abort();
      return abort;
    }
    resume.current?.abort();
    resume.current = abort;
    return abort;
  }, [capture]);
  const closeStream = useCallback(() => {
    if (capture()()) {
      cancelResume();
      setStreaming(undefined);
    }
  }, [capture, cancelResume]);
  useLayoutEffect(() => {
    setStreaming(undefined);
    return () => {
      resume.current?.abort();
      resume.current = undefined;
    };
  }, [owner]);
  useLayoutEffect(() => {
    if (!input.open) closeStream();
  }, [input.open, closeStream]);
  const beginStream = useCallback(
    (item: ExternalSourceItemView, fromStart = false) => {
      const active = capture();
      if (!active()) return false;
      cancelResume();
      const sourceId = item.key.connectorId as ExtensionContributionId;
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);

      const assertCurrent = () => {
        if (!active()) throw new DOMException('Source owner changed', 'AbortError');
        const current = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
        if (
          current.state !== connection.state ||
          current.accountConnectionId !== connection.accountConnectionId ||
          current.connectionGeneration !== connection.connectionGeneration
        )
          throw new DOMException('Source connection changed', 'AbortError');
      };
      const getOptions = () => {
        assertCurrent();
        return optionsRef.current;
      };
      const port = optionsRef.current.registry.getSourceStream?.(item.key.connectorId as ExtensionContributionId);
      if (!port) return false;
      const { assets, getParagraphPage } = optionsRef.current;
      const savedPort: SourceReadingPort =
        isTextStream(port) && getParagraphPage
          ? {
              kind: 'text',
              open: async (remoteId, signal, remoteRevision) => {
                const { savedSourceStream } = await import('./source-stream-library');
                signal.throwIfAborted();
                assertCurrent();
                const saved = savedSourceStream(port, getOptions, item);
                return saved.open(remoteId, signal, remoteRevision);
              },
            }
          : !isTextStream(port) && assets && getParagraphPage
            ? {
                open: async (remoteId: string, signal: AbortSignal) => {
                  const { savedSourceStream } = await import('./source-stream-library');
                  signal.throwIfAborted();
                  assertCurrent();
                  const saved = savedSourceStream(port, getOptions, item);
                  return saved.open(remoteId, signal);
                },
              }
            : port;
      setStreaming((snapshot) => {
        const current = snapshot?.owner === owner ? snapshot.value : undefined;
        return {
          owner,
          connectionKey: JSON.stringify([
            connection.state,
            connection.accountConnectionId,
            connection.connectionGeneration,
          ]),
          value: {
            item,
            fromStart,
            port:
              snapshot?.connectionKey ===
                JSON.stringify([connection.state, connection.accountConnectionId, connection.connectionGeneration]) &&
              current?.item.key.connectorId === item.key.connectorId &&
              current?.item.key.accountConnectionId === item.key.accountConnectionId
                ? current.port
                : ownedSourceStreamPort(savedPort, assertCurrent),
            historyKey: JSON.stringify([optionsRef.current.settingsScope, externalItemKeyId(item.key)]),
          },
        };
      });
      latest.current.onStreamStarted?.(item);
      return true;
    },
    [owner, capture, cancelResume],
  );

  const resumeSourceVisit = useCallback(
    async (visit: SourceReleasePreference) => {
      if (!visit.collectionRemoteId) return;
      cancelResume();
      const active = capture();
      if (!active()) return;
      const abort = startResume();
      try {
        const current = optionsRef.current;
        const sourceId = visit.source.connectorId as ExtensionContributionId;
        if (!current.registry.getSourceStream?.(sourceId))
          throw new Error('이 소스에서 이어 읽기를 지원하지 않습니다.');
        const connection = current.registry.getExternalSourceStatus(sourceId, current.hostContext);
        if (connection.state !== 'connected' || connection.accountConnectionId !== visit.source.accountConnectionId)
          throw new Error('마지막으로 읽은 회차를 열려면 해당 소스 계정으로 연결해 주세요.');
        const check = () => {
          abort.signal.throwIfAborted();
          if (!active()) throw new DOMException('Source owner changed', 'AbortError');
          const latestConnection = current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
          if (
            latestConnection.state !== 'connected' ||
            latestConnection.accountConnectionId !== connection.accountConnectionId ||
            latestConnection.connectionGeneration !== connection.connectionGeneration
          )
            throw new Error('소스 연결이 변경되었습니다. 다시 열어 주세요.');
        };
        const key = externalItemKeyId(visit.source);
        let resumeCatalog: ExternalItemPage | undefined;
        let item = latest.current.items().find((item) => externalItemKeyId(item.key) === key);
        if (!item) {
          const input = { parentRef: visit.collectionRemoteId };
          const cached = await current.state.getCachePage(
            cachePageId(
              sourceId,
              connection.accountConnectionId,
              input,
              current.settingsScope,
              connection.connectionGeneration,
            ),
          );
          check();
          item = cached?.items.find((item) => externalItemKeyId(item.key) === key);
          if (!item) {
            const signal = abort.signal;
            const read = (cursor?: string) =>
              current.registry.listExternalSource(sourceId, current.hostContext, { ...input, cursor }, signal);
            const catalog = await completeSeriesCatalog(await read(), (cursor) => read(cursor), signal);
            resumeCatalog = catalog;
            item = catalog.items.find((item) => externalItemKeyId(item.key) === key);
          }
        }
        check();
        if (resumeCatalog) {
          const input = { parentRef: visit.collectionRemoteId, accountConnectionId: connection.accountConnectionId };
          await saveSourceCache(current.state, {
            ...storedSourcePage(
              cachePageId(
                sourceId,
                connection.accountConnectionId,
                input,
                current.settingsScope,
                connection.connectionGeneration,
              ),
              sourceId,
              input,
              resumeCatalog,
              current.settingsScope,
            ),
            completeSeries: true,
          });
          check();
        }
        if (!item?.release) throw new Error('마지막으로 읽은 회차를 소스 목록에서 찾지 못했습니다.');
        const target = { ...item, selected: false, importState: 'available' as const };
        if (latest.current.openLibrary && preferTextLibrary(target, current.registry.getSourceStream?.(sourceId)))
          await latest.current.openLibrary(target);
        else beginStream(target);
      } catch (error) {
        if (abort.signal.aborted || !active()) return;
        optionsRef.current.notify(error instanceof Error ? error.message : '읽던 회차를 열지 못했습니다.', 'warning');
      }
    },
    [beginStream, cancelResume, capture, startResume],
  );
  return { streaming, beginStream, resumeSourceVisit, startResume, cancelResume, closeStream };
}
