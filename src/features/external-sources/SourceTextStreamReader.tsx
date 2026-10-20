import { translationSnapshot } from '../translation/translation-snapshot';
import { preloadBookWorkspaceReaderBody } from '../book-workspace/book-workspace-reader-preload';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { stableId } from '../../domain/hash';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReaderScreen from '../reader/ReaderScreen';
import { ReaderScreenHandle, type ReaderScreenActions } from '../reader/reader-screen-contract';
import type { ReaderSettings } from '../../domain/types';
import type { SourceTextStreamPort } from '../../external-sources/source-text-stream';
import { SourceReadCache } from '../../external-sources/source-read-cache';
import { useSourceReadingPreferences } from './use-source-reading-preferences';
import { sourceTextDocument } from './source-text-document';
import type { SourceStreamReaderProps } from './SourceStreamReader';

import { UiNextStreamLoading } from '../../ui-next/reader/UiNextStreamLoading';
export interface SourceTextReaderOptions {
  settings: ReaderSettings;
  settingsOpen: boolean;
  actions: Pick<
    ReaderScreenActions,
    | 'openSettings'
    | 'flushReadingSettings'
    | 'retryReadingSettings'
    | 'adjustFontSize'
    | 'adjustContentWidth'
    | 'toggleNightTheme'
    | 'updateReadingProfile'
    | 'setReadingBookOverride'
    | 'closeActiveLayer'
    | 'notify'
  >;
}
export function SourceTextStreamReader(
  props: Omit<SourceStreamReaderProps, 'port' | 'textReader'> & {
    port: SourceTextStreamPort;
    textReader: SourceTextReaderOptions;
  },
) {
  const {
    port,
    remoteId,
    remoteRevision,
    historyKey = remoteId,
    profileKey = historyKey,
    textReader,
    previous,
    next,
    navigationBusy,
  } = props;
  const [handle] = useState(() => new ReaderScreenHandle());
  const source = useMemo(() => ({ cache: new SourceReadCache(), port }), [port]);
  const { cache } = source;
  const preferences = useSourceReadingPreferences(true);
  const [opened, setOpened] = useState<{
    key: string;
    document: Awaited<ReturnType<typeof sourceTextDocument>>;
    epoch: number;
  }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [moving, setMoving] = useState(false);
  const movement = useRef(false);
  const direction = useRef(1);
  const retryMove = useRef<() => Promise<void>>();
  const latest = useRef(props);
  latest.current = props;
  const saves = useRef(new Set<string>());
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const onPosition = latest.current.onTextPosition;
    void cache
      .read(JSON.stringify([remoteId, remoteRevision]), 120000, 120000, controller.signal, false, (signal) =>
        port.open(remoteId, signal, remoteRevision),
      )
      .then(async ({ value }) => {
        controller.signal.throwIfAborted();
        return sourceTextDocument({
          signal: controller.signal,
          text: value.text,
          title: props.title,
          workId: profileKey,
          episodeId: remoteId,
          historyKey,
          settings: latest.current.textReader.settings,
          onPosition,
          fromStart: props.fromStart,
        });
      })
      .then(async (document) => {
        await preloadBookWorkspaceReaderBody(document.repository, document.novel, document.chapter, {});
        controller.signal.throwIfAborted();
        const position =
          direction.current < 0
            ? {
                id: document.chapter.id,
                deviceId: 'reader',
                novelId: document.novel.id,
                chapterId: document.chapter.id,
                paragraphIndex: document.chapter.paragraphCount,
                offsetInParagraph: 0,
                chapterProgress: 1,
                scrollTop: Number.MAX_SAFE_INTEGER,
                updatedAt: new Date().toISOString(),
              }
            : document.position;
        const request = handle.prepareOpen(document.chapter.id, { restore: Boolean(position), position });
        setOpened({ key: historyKey, document, epoch: request.sequence });
        movement.current = false;
        setMoving(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(
            packageOperationMessage(error) ?? (error instanceof Error ? error.message : '회차를 열지 못했습니다.'),
          );
          movement.current = false;
          setMoving(false);
        }
      });
    return () => controller.abort();
  }, [port, cache, remoteId, remoteRevision, historyKey, profileKey, props.title, props.fromStart, attempt, handle]);
  useEffect(() => {
    if (
      !opened ||
      opened.key !== historyKey ||
      preferences.mode !== 'stream-save' ||
      props.saved ||
      props.saveBusy ||
      saves.current.has(historyKey)
    )
      return;
    saves.current.add(historyKey);
    void latest.current.onSave().catch(() => undefined);
  }, [opened, historyKey, preferences.mode, props.saved, props.saveBusy]);
  useEffect(() => {
    if (props.saved && opened?.key === historyKey)
      void opened.document
        .flushSavedPosition()
        .catch(() => latest.current.textReader.actions.notify('읽던 위치를 저장하지 못했습니다.', 'warning'));
  }, [props.saved, opened, historyKey]);
  const nextId = props.nextEpisode?.remoteId;
  const nextRevision = props.nextEpisode?.remoteRevision;
  useEffect(() => {
    let controller = new AbortController();
    let timer: number | undefined;
    const warm = () => {
      window.clearTimeout(timer);
      controller.abort();
      controller = new AbortController();
      if (
        !opened ||
        opened.key !== historyKey ||
        !preferences.prefetch ||
        !nextId ||
        document.visibilityState === 'hidden' ||
        !navigator.onLine ||
        (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
      )
        return;
      const id = nextId;
      timer = window.setTimeout(() => {
        void cache
          .read(JSON.stringify([id, nextRevision]), 120000, 120000, controller.signal, false, (signal) =>
            port.open(id, signal, nextRevision),
          )
          .catch(() => undefined);
      }, 200);
    };
    warm();
    document.addEventListener('visibilitychange', warm);
    window.addEventListener('online', warm);
    window.addEventListener('offline', warm);
    return () => {
      // React cleans up the old prefetch before subscribing the new foreground
      // reader. Let that subscription join the same request in this effect flush.
      // Cache disposal still cancels immediately on close or connection changes.
      const retiring = controller;
      queueMicrotask(() => retiring.abort());
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', warm);
      window.removeEventListener('online', warm);
      window.removeEventListener('offline', warm);
    };
  }, [opened, historyKey, preferences.prefetch, nextId, nextRevision, cache, port]);
  const move = async (action: typeof next, isCurrent = () => true) => {
    if (!action || movement.current || navigationBusy || opened?.key !== historyKey || !isCurrent()) return;
    direction.current = action === previous ? -1 : 1;
    retryMove.current = undefined;
    movement.current = true;
    setMoving(true);
    try {
      await action(() => latest.current.remoteId === remoteId && isCurrent());
    } catch (error) {
      movement.current = false;
      setMoving(false);
      if (!isCurrent()) return;
      retryMove.current = () => move(action);
      setError(
        packageOperationMessage(error) ?? (error instanceof Error ? error.message : '회차 이동에 실패했습니다.'),
      );
    }
  };
  handle.setActions({
    ...handle.getActions(),
    ...textReader.actions,
    returnToChapters: props.onClose,
    openAddon: (tab) =>
      tab === 'outline'
        ? props.onClose()
        : textReader.actions.notify('주석·듣기는 서재에 저장한 작품에서 사용할 수 있습니다.'),
    openChapter: async (chapter) => move(chapter.index < 2 ? previous : next),
  });
  if (!opened)
    return (
      <UiNextStreamLoading
        variant="text"
        workTitle={props.workTitle}
        episodeTitle={props.title}
        error={error || undefined}
        onRetry={() => setAttempt((n) => n + 1)}
        onClose={props.onClose}
      />
    );

  const { novel, chapter, repository, position } = opened.document;
  const chapters = [
    ...(previous ? [{ ...chapter, id: `${chapter.id}:previous`, index: 1, title: '이전 화' }] : []),
    chapter,
    ...(next
      ? [
          {
            ...chapter,
            id: props.nextEpisode
              ? stableId('source_text_chapter', `${profileKey}:${props.nextEpisode.remoteId}`)
              : `${chapter.id}:next`,
            index: 3,
            title: props.nextEpisode?.title ?? '다음 화',
          },
        ]
      : []),
  ];
  // Keep indexes contiguous for the normal reader; episode selection still belongs to the shared source catalog.
  const normalized = chapters.map((c, index) => ({ ...c, index: index + 1 }));
  const current = normalized.find((c) => c.id === chapter.id)!;
  handle.setActions({
    ...handle.getActions(),
    openChapter: async (target) => move(target.index < current.index ? previous : next),
  });
  return (
    <ReaderScreen
      repository={repository}
      screenHandle={handle}
      model={{
        // The stream document is one episode; the header's upper line names the work like library episodes.
        novel: {
          ...novel,
          title: props.workTitle ? props.workTitle : novel.title,
          totalChapters: normalized.length,
        },
        chapter: current,
        chapters: normalized,
        settings: textReader.settings,
        bookmarks: [],
        highlights: [],
        localReadingPosition: position,
        addonOpen: false,
        addonTab: 'outline',
        overlays: { settingsOpen: textReader.settingsOpen, syncPanelOpen: false, importOpen: false },
        canRestoreSavedPosition: Boolean(position),
        statsVisible: false,
        openRequestVersion: opened.epoch,
        transient: true,
        navigation: {
          scope: `source-text:${profileKey}:${opened.epoch}`,
          nextScope: `source-text:${profileKey}:${opened.epoch + 1}`,
          openNext: (isCurrent) => move(next, isCurrent),
          prepareTranslationNext: async (signal) => {
            const episode = latest.current.nextEpisode;
            if (!episode || latest.current.historyKey !== props.historyKey) return undefined;
            const { value } = await cache.read(
              JSON.stringify([episode.remoteId, episode.remoteRevision]),
              120000,
              120000,
              signal,
              false,
              (inner) => port.open(episode.remoteId, inner, episode.remoteRevision),
            );
            signal.throwIfAborted();
            const prepared = await sourceTextDocument({
              text: value.text,
              title: episode.title,
              workId: profileKey,
              episodeId: episode.remoteId,
              historyKey: `${profileKey}:translation-preview`,
              settings: latest.current.textReader.settings,
              fromStart: true,
              signal,
            });
            const paragraphs = await translationSnapshot(prepared.repository, prepared.chapter, signal);
            signal.throwIfAborted();
            return { workKey: prepared.novel.id, chapterKey: prepared.chapter.id, paragraphs };
          },
          busy: moving || Boolean(navigationBusy) || opened.key !== historyKey,
          // Same "N화 여는 중" indicator as library episodes while the next stream opens.
          pending:
            moving || opened.key !== historyKey
              ? {
                  chapterId: direction.current > 0 ? (normalized.at(-1)?.id ?? chapter.id) : normalized[0].id,
                  // Once the controller has switched episodes, props already name the target.
                  title:
                    opened.key !== historyKey
                      ? props.title
                      : direction.current > 0
                        ? (props.nextEpisode?.title ?? '다음 화')
                        : '이전 화',
                  phase: 'opening',
                }
              : undefined,
          error,
          retry: () => {
            setError('');
            if (retryMove.current) void retryMove.current();
            else setAttempt((n) => n + 1);
          },
        },
      }}
    />
  );
}
