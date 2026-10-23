import { ContinuousComicWindow } from './continuous-comic-window';
import { latestSourceStreamPosition } from '../../external-sources/source-stream-position';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { isTextStream, type SourceReadingPort } from '../../external-sources/source-text-stream';
import type { SourceTextReaderOptions } from './SourceTextStreamReader';
const SourceTextStreamReader = lazy(() =>
  import('./SourceTextStreamReader').then((module) => ({ default: module.SourceTextStreamReader })),
);
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';

const FixedDocumentScreen = lazy(() => import('../fixed-document/FixedDocumentScreen'));
import { UiNextStreamLoading } from '../../ui-next/reader/UiNextStreamLoading';

import type { SourceComicLayoutState } from '../fixed-document/use-source-comic-layout';
import '../fixed-document/fixed-document.css';
import type { SourceStreamPort, SourceStreamSession } from '../../external-sources/source-stream';
import { SourceStreamBuffer } from '../../external-sources/source-stream-buffer';
import { useSourceReadingPreferences } from './use-source-reading-preferences';
import { readSourceStreamPosition, saveSourceStreamPosition } from '../../external-sources/source-stream-history';
import { sourceStreamDocument } from './source-stream-document';
import { stableId } from '../../domain/hash';

function ComicStreamReader({
  title,
  workTitle,
  remoteId,
  historyKey = remoteId,
  profileKey: workScope,
  fromStart = false,
  port,
  onClose,
  onSave,
  onPageSettled,
  saved,
  saveBusy,
  previous,
  next,
  nextEpisode,
  navigationBusy,
  neighbor,
}: Omit<SourceStreamReaderProps, 'port'> & { port: SourceStreamPort }) {
  const preferences = useSourceReadingPreferences();
  const profileKey = workScope ?? historyKey;
  const { buffer, saveAttempts } = useMemo(
    () => ({ buffer: new SourceStreamBuffer(port), workScope, saveAttempts: new Set<string>() }),
    [port, workScope],
  );
  const [openedState, setOpened] = useState<{
    owner: SourceStreamBuffer;
    session: SourceStreamSession;
    key: string;
    title: string;
    epoch: number;
    fromStart: boolean;
  }>();
  const opened = openedState?.owner === buffer ? openedState : undefined;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<typeof openedState>();
  const movingRef = useRef(false);
  const retryJoinedDirection = useRef<-1 | 1>(1);
  const [moving, setMoving] = useState(false);
  const [, refreshJoined] = useState(0);
  const [joinedEntry, setJoinedEntry] = useState<{ owner: ContinuousComicWindow; id: string; version: number }>();
  const [layout, setLayout] = useState<SourceComicLayoutState>();
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && navigator.onLine);
  const callbacks = useRef({ onSave, onPageSettled, nextEpisode, neighbor, saved, saveBusy, mode: preferences.mode });
  callbacks.current = { onSave, onPageSettled, nextEpisode, neighbor, saved, saveBusy, mode: preferences.mode };
  useEffect(() => () => buffer.close(), [buffer]);
  useEffect(() => {
    const update = () => setForeground(document.visibilityState !== 'hidden' && navigator.onLine);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void buffer
      .open(remoteId, controller.signal)
      .then((session) => {
        if (controller.signal.aborted) return;
        setOpened((before) => ({
          owner: buffer,
          session,
          key: historyKey,
          title,
          fromStart,
          epoch: (before?.epoch ?? -1) + 1,
        }));
        movingRef.current = false;
        setMoving(false);
        buffer.retain([remoteId, ...(callbacks.current.nextEpisode ? [callbacks.current.nextEpisode.remoteId] : [])]);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          movingRef.current = false;
          setMoving(false);
          setError(
            packageOperationMessage(error) ?? (error instanceof Error ? error.message : '회차를 열지 못했습니다.'),
          );
        }
      });
    return () => controller.abort();
  }, [buffer, remoteId, historyKey, title, attempt, fromStart]);
  const projection = useMemo(
    () =>
      opened
        ? sourceStreamDocument(
            stableId('source_stream', opened.key),
            opened.title,
            opened.session,
            () => setLoaded(opened),
            workTitle,
          )
        : undefined,
    [opened, workTitle],
  );
  const joined = useMemo(
    () =>
      opened && neighbor
        ? new ContinuousComicWindow(
            {
              remoteId,
              title: opened.title,
              historyKey: opened.key,
              onSave,
              onPageSettled,
            },
            opened.session,
            buffer,
            (id, direction, signal) => callbacks.current.neighbor!(id, direction, signal),
            () => refreshJoined((value) => value + 1),
            (episode) => {
              if (
                callbacks.current.mode === 'stream-save' &&
                !(episode.remoteId === remoteId && (callbacks.current.saved || callbacks.current.saveBusy)) &&
                !saveAttempts.has(`save:${episode.remoteId}`)
              ) {
                saveAttempts.add(`save:${episode.remoteId}`);
                void episode.onSave().catch(() => undefined);
              }
            },
            workTitle,
          )
        : undefined,
    // Root entry owns the work session; callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opened, buffer, Boolean(neighbor)],
  );
  useEffect(() => joined?.acquire(), [joined]);
  const currentJoinedEntry = joinedEntry?.owner === joined ? joinedEntry : undefined;
  const displayed = joined
    ? { novel: joined.novel, chapters: joined.chapters, repository: joined.repository, assets: joined.assets }
    : projection;
  const joinedChapters = joined?.chapters;
  const pageLocations = useMemo(
    () =>
      new Map(
        joinedChapters?.flatMap((chapter) => {
          const location = joined?.locateId(chapter.id);
          return location ? [[chapter.id, location] as const] : [];
        }) ?? [],
      ),
    [joined, joinedChapters],
  );
  const position = useMemo(() => {
    if (!opened || opened.fromStart) return undefined;
    return latestSourceStreamPosition(
      opened.session.pageCount,
      readSourceStreamPosition(opened.key),
      opened.session.initialPosition,
    );
  }, [opened]);
  useEffect(() => {
    if (
      !opened ||
      opened.key !== historyKey ||
      loaded !== opened ||
      preferences.mode !== 'stream-save' ||
      saved ||
      saveBusy ||
      saveAttempts.has(`save:${remoteId}`)
    )
      return;
    saveAttempts.add(`save:${remoteId}`);
    // Failures are reported by the existing download task and retried from the episode list.
    void callbacks.current.onSave().catch(() => undefined);
  }, [opened, loaded, historyKey, remoteId, preferences.mode, saved, saveBusy, saveAttempts]);
  const nextId = nextEpisode?.remoteId;
  const prefetchPages =
    foreground && !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
      ? preferences.prefetch
      : 0;
  useEffect(() => {
    if (!nextId || !opened || opened.key !== historyKey || loaded !== opened || !foreground || !prefetchPages) return;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const controller = new AbortController();
    // Wait until the current viewer has submitted its visible pages, then warm one neighbor.
    const timer = window.setTimeout(() => {
      void buffer
        .open(nextId, controller.signal)
        .then(async (session) => {
          for (let index = 0; index < Math.min(session.pageCount, prefetchPages); index++) {
            controller.signal.throwIfAborted();
            try {
              await session.loadPage(index, controller.signal);
            } catch {
              controller.signal.throwIfAborted(); /* Retry individual failures when they become visible. */
            }
          }
          controller.signal.throwIfAborted();
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [buffer, nextId, opened, historyKey, loaded, prefetchPages, foreground]);
  const move = async (action: typeof next, isCurrent?: () => boolean) => {
    if (!action || movingRef.current || navigationBusy || opened?.key !== historyKey || (isCurrent && !isCurrent()))
      return;
    // The controller selects a target before its stream has opened. Keep ownership
    // with the displayed episode until that open completes, including repeated wheel gestures.
    movingRef.current = true;
    setMoving(true);
    try {
      await action(isCurrent);
    } catch (error) {
      movingRef.current = false;
      setMoving(false);
      throw error;
    }
  };
  const moveJoined = async (direction: -1 | 1, isCurrent?: () => boolean) => {
    if (!joined || movingRef.current || (isCurrent && !isCurrent())) return;
    movingRef.current = true;
    setMoving(true);
    retryJoinedDirection.current = direction;
    try {
      const entry = await joined.adjacent(direction);
      if (entry && !joined.controller.signal.aborted && (!isCurrent || isCurrent())) {
        const chapter = direction === 1 ? entry.projection.chapters[0] : entry.projection.chapters.at(-1);
        if (chapter)
          setJoinedEntry((value) => ({
            owner: joined,
            id: chapter.id,
            version: (value?.owner === joined ? value.version : 0) + 1,
          }));
      }
    } finally {
      movingRef.current = false;
      setMoving(false);
    }
  };
  if (!opened || !projection || !displayed)
    return (
      <UiNextStreamLoading
        workTitle={workTitle}
        episodeTitle={title}
        error={error || undefined}
        onRetry={() => setAttempt((value) => value + 1)}
        onClose={onClose}
      />
    );

  return (
    <>
      <Suspense fallback={<UiNextStreamLoading workTitle={workTitle} episodeTitle={opened.title} onClose={onClose} />}>
        <FixedDocumentScreen
          {...displayed}
          initialChapterId={
            currentJoinedEntry?.id ??
            joined?.initialChapterIds[position?.page ?? 0] ??
            projection.chapters[position?.page ?? 0]?.id
          }
          entryRequestVersion={opened.epoch + (currentJoinedEntry?.version ?? 0)}
          onBack={onClose}
          remoteNavigation={{
            continuous: joined
              ? {
                  status: joined.status(1),
                  previousStatus: joined.status(-1),
                  prepare: (direction, retry) => {
                    void joined.prepare(direction, retry);
                  },
                  observed: (index) => joined.observe(index),
                }
              : undefined,
            invalidatePage: joined ? (index) => joined.invalidate(index) : opened.session.invalidatePage,
            scope: `stream:${opened.epoch}:${currentJoinedEntry?.version ?? 0}`,
            nextScope: joined
              ? `stream:${opened.epoch}:${(currentJoinedEntry?.version ?? 0) + 1}`
              : `stream:${opened.epoch + 1}:0`,
            profileKey,
            busy: moving || navigationBusy || opened.key !== historyKey,
            prefetchPages,
            previous: joined
              ? joined.canNavigate(-1)
                ? (isCurrent) => moveJoined(-1, isCurrent)
                : undefined
              : previous
                ? (isCurrent) => move(previous, isCurrent)
                : undefined,
            next: joined
              ? joined.canNavigate(1)
                ? (isCurrent) => moveJoined(1, isCurrent)
                : undefined
              : next
                ? (isCurrent) => move(next, isCurrent)
                : undefined,
            nextTitle: nextEpisode?.title,
            error:
              error ||
              (joined && (joined.status(1) === 'error' || joined.status(-1) === 'error')
                ? '회차를 불러오지 못했습니다.'
                : ''),
            retry: joined
              ? () => void moveJoined(retryJoinedDirection.current)
              : () => setAttempt((value) => value + 1),
            initialPosition: currentJoinedEntry ? undefined : position,
            savePosition: (value) => {
              const id = value.chapterId ?? joinedChapters?.[value.page]?.id;
              // Viewport capture is entry-scoped and may retain this callback
              // while the same window gains chapters. Resolve new page IDs
              // through that window, retaining the old map for a final flush.
              const location = id ? (joined?.locateId(id) ?? pageLocations.get(id)) : undefined;
              if (location)
                saveSourceStreamPosition(location.entry.episode.historyKey, {
                  ...value,
                  page: location.page,
                  count: location.entry.count,
                });
              else if (!joined) saveSourceStreamPosition(opened.key, { ...value, count: opened.session.pageCount });
            },
          }}
          onPageSettled={(page, _chapter, _novel, position) => {
            const location = pageLocations.get(_chapter.id);
            if (location) {
              const currentIndex = joined?.chapters.findIndex((chapter) => chapter.id === _chapter.id) ?? -1;
              if (currentIndex >= 0) joined!.observe(currentIndex);
              return location.entry.episode.onPageSettled?.(location.page, location.entry.count, position?.fraction);
            }
            if (!joined && opened.key === historyKey)
              return onPageSettled?.(page, opened.session.pageCount, position?.fraction);
          }}
          onLayoutStateChange={setLayout}
        />
      </Suspense>
      {!layout?.layoutReady && (
        <UiNextStreamLoading
          workTitle={workTitle}
          episodeTitle={opened.title}
          error={layout?.error ? '보기 방식을 정하지 못했어요. 다시 시도해 주세요.' : undefined}
          onRetry={layout?.retry}
          onClose={onClose}
        />
      )}
    </>
  );
}

export interface SourceStreamEpisode {
  remoteId: string;
  title: string;
  remoteRevision?: string;
  historyKey: string;
  onSave(): Promise<void>;
  onPageSettled?(page: number, count: number, fraction?: number): void | Promise<void>;
  onTextPosition?: SourceStreamReaderProps['onTextPosition'];
}

export type SourceStreamReaderProps = {
  neighbor?(remoteId: string, direction: -1 | 1, signal: AbortSignal): Promise<SourceStreamEpisode | undefined>;
  /** Work identity, distinct from title (the current episode). Also used for locally cached streams. */
  workTitle?: string;
  title: string;
  remoteId: string;
  remoteRevision?: string;
  historyKey?: string;
  profileKey?: string;
  fromStart?: boolean;
  port: SourceReadingPort;
  textReader?: SourceTextReaderOptions;
  onTextPosition?: (position: {
    paragraphIndex: number;
    offset: number;
    textHash: string;
    count: number;
  }) => Promise<void>;
  onClose(): void;
  onSave(): Promise<void>;
  onPageSettled?(page: number, count: number, fraction?: number): void | Promise<void>;
  saved?: boolean;
  saveBusy?: boolean;
  previous?: (isCurrent?: () => boolean) => Promise<void>;
  next?: (isCurrent?: () => boolean) => Promise<void>;
  nextEpisode?: { remoteId: string; title: string; remoteRevision?: string };
  navigationBusy?: boolean;
};
export function SourceStreamReader(props: SourceStreamReaderProps) {
  if (isTextStream(props.port)) {
    if (!props.textReader) throw new Error('텍스트 리더 설정을 불러오지 못했습니다.');
    return (
      <Suspense
        fallback={
          <UiNextStreamLoading
            variant="text"
            workTitle={props.workTitle}
            episodeTitle={props.title}
            onClose={props.onClose}
          />
        }
      >
        <SourceTextStreamReader {...props} port={props.port} textReader={props.textReader} />
      </Suspense>
    );
  }
  return <ComicStreamReader {...props} port={props.port} />;
}
