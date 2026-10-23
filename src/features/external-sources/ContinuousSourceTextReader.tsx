import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter } from '../../domain/types';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { SourceTextStreamPort } from '../../external-sources/source-text-stream';
import { ReaderScreenHandle, type OpenReaderChapterOptions } from '../reader/reader-screen-contract';
import type { ContinuousTextChapter, ContinuousTextSource } from '../reader/continuous-text-window';
import ReaderScreen from '../reader/ReaderScreen';
import { sourceTextDocument } from './source-text-document';
import { translationSnapshot } from '../translation/translation-snapshot';
import type { SourceStreamEpisode, SourceStreamReaderProps } from './SourceStreamReader';
import type { SourceTextReaderOptions } from './SourceTextStreamReader';
import { useSourceReadingPreferences } from './use-source-reading-preferences';

type Document = Awaited<ReturnType<typeof sourceTextDocument>>;
interface Entry {
  episode: SourceStreamEpisode;
  chapter: Chapter;
}

/** A work-owned reader. Preparing an episode never changes the external catalog's selected item. */
export function ContinuousSourceTextReader(
  props: SourceStreamReaderProps & {
    port: SourceTextStreamPort;
    textReader: SourceTextReaderOptions;
    initial: Document;
  },
) {
  const latest = useRef(props);
  latest.current = props;
  const [handle] = useState(() => new ReaderScreenHandle());
  const [, publish] = useState(0);
  const [active, setActive] = useState(props.initial.chapter);
  const [openVersion, setOpenVersion] = useState(
    () =>
      handle.prepareOpen(props.initial.chapter.id, {
        restore: Boolean(props.initial.position),
        position: props.initial.position,
      }).sequence,
  );
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  const movePending = useRef(false);
  const retryTarget = useRef<{ chapter: Chapter; options?: OpenReaderChapterOptions }>();
  const preferences = useSourceReadingPreferences(true);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const lease = useRef(0);
  const session = useMemo(() => {
    const controller = new AbortController();
    const entries = new Map<string, Entry>([
      [
        props.initial.chapter.id,
        {
          chapter: props.initial.chapter,
          episode: {
            remoteId: props.remoteId,
            remoteRevision: props.remoteRevision,
            title: props.title,
            historyKey: props.historyKey ?? props.remoteId,
            onSave: props.onSave,
            onTextPosition: props.onTextPosition,
          },
        },
      ],
    ]);
    const documents = new Map<string, Document>([[props.initial.chapter.id, props.initial]]);
    const loads = new Map<string, Promise<Document>>();
    const saved = new Set<string>([props.initial.chapter.id]);
    const ensure = (entry: Entry): Promise<Document> => {
      const cached = documents.get(entry.chapter.id);
      if (cached) return Promise.resolve(cached);
      const pending = loads.get(entry.chapter.id);
      if (pending) return pending;
      const task = latest.current.port
        .open(entry.episode.remoteId, controller.signal, entry.episode.remoteRevision)
        .then((value) =>
          sourceTextDocument({
            text: value.text,
            title: entry.episode.title,
            workId: latest.current.profileKey ?? latest.current.historyKey ?? latest.current.remoteId,
            episodeId: entry.episode.remoteId,
            historyKey: entry.episode.historyKey,
            settings: latest.current.textReader.settings,
            fromStart: true,
            signal: controller.signal,
            onPosition: entry.episode.onTextPosition,
          }),
        )
        .then((document) => {
          controller.signal.throwIfAborted();
          if (
            document.chapter.textHash !== entry.chapter.textHash ||
            document.chapter.paragraphCount !== entry.chapter.paragraphCount
          )
            throw new Error('회차 본문이 변경됐습니다. 회차 목록에서 다시 열어 주세요.');
          documents.set(entry.chapter.id, document);
          return document;
        })
        .finally(() => loads.delete(entry.chapter.id));
      loads.set(entry.chapter.id, task);
      return task;
    };
    const terminal = new Set<string>();
    const neighbors = new Map<string, Promise<ContinuousTextChapter | undefined>>();
    let neighborQueue: Promise<unknown> = Promise.resolve();
    const observe = (id: string) => {
      const entry = entries.get(id);
      if (!entry || controller.signal.aborted) return;
      setActive(entry.chapter);
      if (preferencesRef.current.mode === 'stream-save' && !saved.has(id)) {
        saved.add(id);
        void entry.episode
          .onSave()
          .catch(() => latest.current.textReader.actions.notify('회차를 저장하지 못했습니다.', 'warning'));
      }
    };
    const source: ContinuousTextSource = {
      neighbor: async (id, direction, signal) => {
        signal.throwIfAborted();
        const origin = entries.get(id);
        if (!origin || terminal.has(`${id}:${direction}`)) return undefined;
        const known = [...entries.values()].find((entry) => entry.chapter.index === origin.chapter.index + direction);
        if (known) return { chapter: known.chapter, repository: rootRepository };
        const key = `${id}:${direction}`;
        let pending = neighbors.get(key);
        if (!pending) {
          pending = neighborQueue
            .catch(() => undefined)
            .then(async () => {
              const signal = controller.signal;
              signal.throwIfAborted();
              const episode = await latest.current.neighbor?.(origin.episode.remoteId, direction, signal);
              signal.throwIfAborted();
              if (!episode) {
                terminal.add(`${id}:${direction}`);
                publish((value) => value + 1);
                return undefined;
              }
              signal.throwIfAborted();
              const value = await latest.current.port.open(episode.remoteId, signal, episode.remoteRevision);
              const document = await sourceTextDocument({
                text: value.text,
                title: episode.title,
                workId: latest.current.profileKey ?? latest.current.historyKey ?? latest.current.remoteId,
                episodeId: episode.remoteId,
                historyKey: episode.historyKey,
                settings: latest.current.textReader.settings,
                fromStart: true,
                signal,
                onPosition: episode.onTextPosition,
              });
              signal.throwIfAborted();
              controller.signal.throwIfAborted();
              const chapter = { ...document.chapter, index: origin.chapter.index + direction };
              const entry = { episode, chapter };
              entries.set(chapter.id, entry);
              documents.set(chapter.id, document);
              publish((value) => value + 1);
              return { chapter, repository: rootRepository };
            })
            .finally(() => neighbors.delete(key));
          neighbors.set(key, pending);
          neighborQueue = pending;
        }
        // Each viewport may retire independently; its cancellation must not cancel another consumer.
        // Shared metadata work still belongs to the work session and aborts when that session closes.
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', abort, { once: true });
          void pending!.then(
            (value) => {
              signal.removeEventListener('abort', abort);
              if (signal.aborted) abort();
              else resolve(value);
            },
            (error) => {
              signal.removeEventListener('abort', abort);
              reject(error);
            },
          );
        });
      },
      observed: observe,
      retain: (ids) => {
        for (const id of documents.keys())
          if (!ids.includes(id) && id !== latest.current.initial.chapter.id) documents.delete(id);
      },
    };
    // One work owns one shared-page LRU. Per-episode repository identities would
    // retain a separate cache for every previously visited chapter.
    const rootRepository: ReaderBodyRepository = {
      getChapter: async (id) => entries.get(id)?.chapter,
      getSettings: async () => latest.current.textReader.settings,
      getReadingPosition: async () => undefined,
      getParagraph: async (id, signal) => {
        for (const document of documents.values()) {
          const paragraph = await document.repository.getParagraph(id, signal);
          if (paragraph) return paragraph;
        }
        return undefined;
      },
      getParagraphPage: async (id, page, signal) => {
        const entry = entries.get(id);
        signal?.throwIfAborted();
        return entry && (await ensure(entry)).repository.getParagraphPage(id, page, signal);
      },
      searchParagraphPage: async (request) => {
        const entry = entries.get('chapterId' in request ? (request.chapterId ?? '') : '');
        if (!entry) throw new Error('회차를 찾을 수 없습니다.');
        return (await ensure(entry)).repository.searchParagraphPage(request);
      },
      saveReadingPosition: async (value) => {
        const entry = entries.get(value.chapterId);
        if (!entry) return;
        const document = await ensure(entry);
        controller.signal.throwIfAborted();
        await document.repository.saveReadingPosition({
          ...value,
          expectedContentRevisionId: document.novel.activeContentRevisionId,
        });
      },
    };
    return { source, entries, terminal, controller, documents, repository: rootRepository };
    // Work lifetime is owned by the keyed caller, not by observed chapter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const owner = lease;
    owner.current++;
    return () => {
      owner.current--;
      queueMicrotask(() => {
        if (!owner.current) session.controller.abort();
      });
    };
  }, [session]);
  const open = async (target: Chapter, options?: OpenReaderChapterOptions, isCurrent = () => true) => {
    const current = () => isCurrent() && !options?.navigationSignal?.aborted;
    if (movePending.current || !current()) return;
    movePending.current = true;
    retryTarget.current = { chapter: target, options };
    setMoving(true);
    setError('');
    try {
      let chapter = session.entries.get(target.id)?.chapter;
      if (!chapter)
        chapter = (
          await session.source.neighbor(active.id, target.index < active.index ? -1 : 1, session.controller.signal)
        )?.chapter;
      if (!chapter) throw new Error('더 이동할 회차가 없습니다.');
      if (!current() || session.controller.signal.aborted) return;
      session.source.observed?.(chapter.id);
      const position = options?.position;
      // A not-yet-loaded neighbor is a placeholder with the current chapter's
      // count. Resolve backward-to-end against the actual destination.
      const atEnd = position?.chapterProgress === 1 && position.scrollTop === Number.MAX_SAFE_INTEGER;
      setOpenVersion(
        handle.prepareOpen(chapter.id, {
          ...options,
          position: position && {
            ...position,
            chapterId: chapter.id,
            paragraphIndex: atEnd ? Math.max(chapter.paragraphCount, 1) : position.paragraphIndex,
          },
        }).sequence,
      );
      retryTarget.current = undefined;
    } catch (error) {
      if (current() && !session.controller.signal.aborted)
        setError(error instanceof Error ? error.message : '회차를 열지 못했습니다.');
    } finally {
      movePending.current = false;
      if (!session.controller.signal.aborted) setMoving(false);
    }
  };
  handle.setActions({
    ...handle.getActions(),
    ...props.textReader.actions,
    returnToChapters: props.onClose,
    openChapter: (chapter, options) => open(chapter, options),
    observeChapter: (chapter) => session.source.observed?.(chapter.id),
    openAddon: (tab) =>
      tab === 'outline'
        ? props.onClose()
        : props.textReader.actions.notify('주석·듣기는 서재에 저장한 작품에서 사용할 수 있습니다.'),
  });
  const chapters = [...session.entries.values()].map((entry) => entry.chapter).sort((a, b) => a.index - b.index);
  const neighbors = [-1, 1].flatMap((direction) =>
    session.terminal.has(`${active.id}:${direction}`) ||
    chapters.some((chapter) => chapter.index === active.index + direction)
      ? []
      : [
          {
            ...active,
            id: `${active.id}:neighbor:${direction}`,
            index: active.index + direction,
            title: direction === 1 ? '다음 화' : '이전 화',
          },
        ],
  );
  return (
    <ReaderScreen
      repository={session.repository}
      screenHandle={handle}
      model={{
        novel: { ...props.initial.novel, title: props.workTitle ?? props.initial.novel.title },
        chapter: active,
        chapters: [...chapters, ...neighbors].sort((a, b) => a.index - b.index),
        settings: props.textReader.settings,
        bookmarks: [],
        highlights: [],
        addonOpen: false,
        addonTab: 'outline',
        overlays: { settingsOpen: props.textReader.settingsOpen, syncPanelOpen: false, importOpen: false },
        localReadingPosition: session.documents.get(active.id)?.position,
        canRestoreSavedPosition: Boolean(session.documents.get(active.id)?.position),
        statsVisible: false,
        transient: true,
        continuousSource: session.source,
        openRequestVersion: openVersion,
        navigation: {
          scope: `${props.initial.novel.id}:entry:${openVersion}`,
          nextScope: `${props.initial.novel.id}:entry:${openVersion + 1}`,
          openNext: async (isCurrent) => {
            const next = [...chapters, ...neighbors].find((chapter) => chapter.index === active.index + 1);
            if (next) await open(next, undefined, isCurrent);
          },
          prepareTranslationNext: async (signal) => {
            const entry = await session.source.neighbor(active.id, 1, signal);
            signal.throwIfAborted();
            if (!entry) return undefined;
            const paragraphs = await translationSnapshot(entry.repository, entry.chapter, signal);
            signal.throwIfAborted();
            return { workKey: props.initial.novel.id, chapterKey: entry.chapter.id, paragraphs };
          },
          busy: moving,
          error,
          retry: () => {
            if (retryTarget.current) void open(retryTarget.current.chapter, retryTarget.current.options);
          },
        },
      }}
    />
  );
}
