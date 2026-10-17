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
  profileKey = historyKey,
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
}: Omit<SourceStreamReaderProps, 'port'> & { port: SourceStreamPort }) {
  const preferences = useSourceReadingPreferences();
  const buffer = useMemo(() => new SourceStreamBuffer(port), [port]);
  const [opened, setOpened] = useState<{
    session: SourceStreamSession;
    key: string;
    title: string;
    epoch: number;
    fromStart: boolean;
  }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState('');
  const movingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const [layout, setLayout] = useState<SourceComicLayoutState>();
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden' && navigator.onLine);
  const callbacks = useRef({ onSave, onPageSettled, nextEpisode });
  callbacks.current = { onSave, onPageSettled, nextEpisode };
  const saveAttempts = useRef(new Set<string>());
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
        setOpened((before) => ({ session, key: historyKey, title, fromStart, epoch: (before?.epoch ?? -1) + 1 }));
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
            () => setLoaded(opened.key),
            workTitle,
          )
        : undefined,
    [opened, workTitle],
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
      loaded !== historyKey ||
      preferences.mode !== 'stream-save' ||
      saved ||
      saveBusy ||
      saveAttempts.current.has(`save:${remoteId}`)
    )
      return;
    saveAttempts.current.add(`save:${remoteId}`);
    // Failures are reported by the existing download task and retried from the episode list.
    void callbacks.current.onSave().catch(() => undefined);
  }, [opened, loaded, historyKey, remoteId, preferences.mode, saved, saveBusy]);
  const nextId = nextEpisode?.remoteId;
  const prefetchPages =
    foreground && !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
      ? preferences.prefetch
      : 0;
  useEffect(() => {
    if (!nextId || !opened || opened.key !== historyKey || loaded !== historyKey || !foreground || !prefetchPages)
      return;
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
  if (!opened || !projection)
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
          {...projection}
          initialChapterId={projection.chapters[position?.page ?? 0]?.id}
          entryRequestVersion={opened.epoch}
          onBack={onClose}
          remoteNavigation={{
            invalidatePage: opened.session.invalidatePage,
            scope: `stream:${opened.epoch}`,
            nextScope: `stream:${opened.epoch + 1}`,
            profileKey,
            busy: moving || navigationBusy || opened.key !== historyKey,
            prefetchPages,
            previous: previous ? (isCurrent) => move(previous, isCurrent) : undefined,
            next: next ? (isCurrent) => move(next, isCurrent) : undefined,
            nextTitle: nextEpisode?.title,
            error,
            retry: () => setAttempt((value) => value + 1),
            initialPosition: position,
            savePosition: (value) =>
              saveSourceStreamPosition(opened.key, { ...value, count: opened.session.pageCount }),
          }}
          onPageSettled={(page, _chapter, _novel, position) => {
            if (opened.key === historyKey) return onPageSettled?.(page, opened.session.pageCount, position?.fraction);
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

export type SourceStreamReaderProps = {
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
