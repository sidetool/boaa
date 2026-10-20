import { translationSnapshot } from './translation-snapshot';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import {
  detectTranslationLanguage,
  translationSourceLanguage,
  translationTextParagraphs,
  type TranslationConfiguration,
  type TranslationRequest,
  type TranslationResult,
} from '../../translation/contracts';
import { translationError, useTranslationClient } from './translation-client';

export function useReaderTranslation(model: ReaderScreenModel, repository: ReaderBodyRepository) {
  const client = useTranslationClient();
  const chapterId = model.chapter.id;
  const paragraphCount = model.chapter.paragraphCount;
  const latestModel = useRef(model);
  latestModel.current = model;
  const chapterListKey = JSON.stringify(
    model.chapters.map((chapter) => [chapter.id, chapter.textHash, chapter.paragraphCount]),
  );
  const [configurationState, setConfiguration] = useState<{ client: typeof client; value: TranslationConfiguration }>();
  const configuration = configurationState?.client === client ? configurationState?.value : undefined;
  const [result, setResult] = useState<TranslationResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [following, setFollowing] = useState(false);
  const [pollVersion, refreshPolling] = useState(0);
  const epoch = useRef(0);
  // A manual action supersedes unfinished automatic work within the same source session.
  const operation = useRef(0);
  const starting = useRef(false);
  const polling = useRef<AbortController>();
  const cache = useRef<Promise<TranslationRequest>>();
  const session = useRef(new AbortController());
  const previousClient = useRef(client);
  const intent = useRef({ workKey: model.novel.id, display: false });
  const sourceSession = useMemo(
    () => ({
      workKey: model.novel.id,
      chapterKey: model.chapter.id,
      textHash: model.chapter.textHash,
      paragraphCount: model.chapter.paragraphCount,
      transient: model.transient,
      contentRevision: model.novel.activeContentRevisionId,
      repository,
      settingsRevision: configuration?.revision,
      client,
      language: model.novel.language,
    }),
    [
      model.novel.id,
      model.chapter.id,
      model.chapter.textHash,
      model.chapter.paragraphCount,
      model.transient,
      model.novel.activeContentRevisionId,
      repository,
      configuration?.revision,
      client,
      model.novel.language,
    ],
  );
  const invalidateSession = useCallback(() => {
    epoch.current++;
    session.current.abort();
  }, []);
  const formatSupported = ['txt', 'markdown', 'epub'].includes(model.novel.format ?? 'txt');
  const available = Boolean(client && configuration?.settings.enabled && formatSupported);
  const displaying = wanted && available && model.ttsIndex === undefined;
  useEffect(() => {
    if (!client || !formatSupported) return;
    let abort: AbortController;
    const load = () => {
      abort?.abort();
      const request = new AbortController();
      abort = request;
      void client.configuration(request.signal).then(
        (value) => {
          if (!request.signal.aborted) setConfiguration({ client, value });
        },
        (reason) => {
          if (!request.signal.aborted) setError(translationError(reason));
        },
      );
    };
    load();
    window.addEventListener('boaa-translation-settings', load);
    return () => {
      abort.abort();
      window.removeEventListener('boaa-translation-settings', load);
    };
  }, [client, formatSupported]);
  useEffect(() => {
    epoch.current++;
    session.current.abort();
    session.current = new AbortController();
    starting.current = false;
    cache.current = undefined;
    setResult(undefined);
    setError('');
    setBusy(false);
    if (intent.current.workKey !== sourceSession.workKey || previousClient.current !== sourceSession.client)
      intent.current = { workKey: sourceSession.workKey, display: false };
    previousClient.current = sourceSession.client;
    setWanted(intent.current.display);
    setSourceLanguage('');
    setFollowing(false);
    return invalidateSession;
  }, [sourceSession, invalidateSession]);
  const prepare = useCallback(async () => {
    if (cache.current) return cache.current;
    const signal = session.current.signal;
    const read = model.transient
      ? translationSnapshot(repository, { id: chapterId, paragraphCount }, signal)
      : repository.getParagraphPage(chapterId, 0, signal).then((page) => {
          if (!page) throw new Error('translation_source_changed');
          return translationTextParagraphs(page.paragraphs);
        });
    cache.current = read
      .then((paragraphs) => {
        signal.throwIfAborted();
        const language = translationSourceLanguage(model.novel.language, paragraphs.map((p) => p.text).join('\n'));
        const request: TranslationRequest = {
          workKey: model.novel.id,
          chapterKey: chapterId,
          ...(model.transient
            ? { paragraphs }
            : {
                bookId: model.novel.id,
                revision: model.novel.activeContentRevisionId,
                chapterTextHash: model.chapter.textHash,
              }),
          sourceLanguage: language,
        };
        setSourceLanguage(language ?? '');
        return request;
      })
      .catch((error) => {
        if (!signal.aborted) cache.current = undefined;
        throw error;
      });
    return cache.current;
  }, [
    model.novel.id,
    model.novel.language,
    model.novel.activeContentRevisionId,
    chapterId,
    paragraphCount,
    model.chapter.textHash,
    model.transient,
    repository,
  ]);
  const start = useCallback(
    async (language?: string) => {
      if (!client || !available || starting.current) return;
      starting.current = true;
      polling.current?.abort();
      const action = ++operation.current;
      const ticket = epoch.current;
      const signal = session.current.signal;
      setBusy(true);
      setError('');
      try {
        const prepared = await prepare();
        if (ticket !== epoch.current || action !== operation.current || signal.aborted) return;
        const response = await client.request(
          { ...prepared, sourceLanguage: language || prepared.sourceLanguage, confirmUnknownLanguage: true },
          signal,
        );
        if (ticket !== epoch.current || action !== operation.current || signal.aborted) return;
        setResult(response.result ?? undefined);
        setWanted(true);
        setFollowing(false);
        intent.current = { workKey: model.novel.id, display: true };
        setOpen(false);
      } catch (reason) {
        if (ticket === epoch.current && action === operation.current && !signal.aborted)
          setError(translationError(reason));
      } finally {
        if (ticket === epoch.current) {
          starting.current = false;
          setBusy(false);
          refreshPolling((version) => version + 1);
        }
      }
    },
    [client, available, prepare, model.novel.id],
  );
  useEffect(() => {
    if (!available || !client) return;
    const ticket = epoch.current;
    const action = operation.current;
    const signal = session.current.signal;
    const current = () => ticket === epoch.current && action === operation.current && !signal.aborted;
    void (async () => {
      try {
        const prepared = await prepare();
        if (!current()) return;
        const existing = await client.request({ ...prepared, lookupOnly: true }, signal);
        if (!current()) return;
        setResult(existing.result ?? undefined);
        const automatic =
          configuration?.settings.automatic &&
          prepared.sourceLanguage &&
          prepared.sourceLanguage.split('-')[0].toLowerCase() !==
            configuration.settings.targetLanguage.split('-')[0].toLowerCase() &&
          document.visibilityState === 'visible';
        if (automatic) {
          const response = existing.result?.status === 'complete' ? existing : await client.request(prepared, signal);
          if (!current()) return;
          setResult(response.result ?? undefined);
          setWanted(true);
          setFollowing(configuration.settings.nextChapters > 0);
        }
      } catch (reason) {
        if (ticket === epoch.current && action === operation.current && !signal.aborted)
          setError(translationError(reason));
      }
    })();
  }, [
    available,
    client,
    prepare,
    configuration?.settings.automatic,
    configuration?.settings.nextChapters,
    configuration?.settings.targetLanguage,
    configuration?.revision,
  ]);
  const resultId = result?.id;
  const resultStatus = result?.status;
  useEffect(() => {
    if (busy || !client || !resultId || !['queued', 'running'].includes(resultStatus ?? '')) return;
    const abort = new AbortController();
    polling.current = abort;
    const ticket = epoch.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (abort.signal.aborted || ticket !== epoch.current) return;
      try {
        const next = await client.result(resultId, abort.signal);
        if (!abort.signal.aborted && ticket === epoch.current) setResult(next);
      } catch (reason) {
        if (!abort.signal.aborted && ticket === epoch.current) setError(translationError(reason));
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, resultId, resultStatus, sourceSession, pollVersion, busy]);
  useEffect(() => {
    if (
      !client ||
      !following ||
      result?.status !== 'complete' ||
      !configuration?.settings.automatic ||
      configuration.settings.nextChapters === 0
    )
      return;
    const abort = new AbortController();
    const ticket = epoch.current;
    const action = operation.current;
    const currentSession = () =>
      !abort.signal.aborted &&
      ticket === epoch.current &&
      action === operation.current &&
      document.visibilityState === 'visible';
    const currentModel = latestModel.current;
    const current = currentModel.chapters.findIndex((chapter) => chapter.id === currentModel.chapter.id);
    const next = currentModel.chapters.slice(current + 1, current + 1 + configuration.settings.nextChapters);
    void (async () => {
      if (
        currentModel.transient &&
        currentModel.navigation?.prepareTranslationNext &&
        configuration.settings.nextChapters > 0
      ) {
        try {
          if (!currentSession()) return;
          const prepared = await currentModel.navigation.prepareTranslationNext(abort.signal);
          if (prepared && currentSession()) {
            const text = prepared.paragraphs!.map((p) => p.text).join('\n');
            const nextLanguage = translationSourceLanguage(
              detectTranslationLanguage(text) || currentModel.novel.language,
              text,
            );
            if (
              nextLanguage &&
              nextLanguage.split('-')[0].toLowerCase() !==
                configuration.settings.targetLanguage.split('-')[0].toLowerCase()
            )
              await client.request({ ...prepared, sourceLanguage: nextLanguage, prefetch: true }, abort.signal);
          }
        } catch {
          /* Preparing the next chapter never interrupts the chapter being read. */
        }
        return;
      }
      for (const chapter of next) {
        if (!currentSession() || current < 0) break;
        try {
          // Transient readers only prepare chapters already present in their authorized repository.
          const paragraphs = await translationSnapshot(repository, chapter, abort.signal);
          if (!currentSession()) break;
          const language = translationSourceLanguage(
            detectTranslationLanguage(paragraphs.map((p) => p.text).join('\n')) || currentModel.novel.language,
            paragraphs.map((p) => p.text).join('\n'),
          );
          if (
            !language ||
            language.split('-')[0].toLowerCase() === configuration.settings.targetLanguage.split('-')[0].toLowerCase()
          )
            continue;
          await client.request(
            {
              workKey: model.novel.id,
              chapterKey: chapter.id,
              ...(model.transient
                ? { paragraphs }
                : {
                    bookId: model.novel.id,
                    revision: model.novel.activeContentRevisionId,
                    chapterTextHash: chapter.textHash,
                  }),
              sourceLanguage: language,
              prefetch: true,
            },
            abort.signal,
          );
        } catch {
          break;
        }
      }
    })();
    return () => abort.abort();
  }, [
    client,
    following,
    result?.id,
    result?.status,
    configuration,
    model.chapter.id,
    chapterListKey,
    model.novel.id,
    model.novel.activeContentRevisionId,
    model.transient,
    repository,
  ]);
  const texts = useMemo(
    () => (displaying ? new Map(result?.paragraphs.map((p) => [p.id, p.text])) : undefined),
    [displaying, result?.paragraphs],
  );
  return {
    available,
    configuration,
    result,
    error,
    busy,
    open,
    setOpen,
    sourceLanguage,
    setSourceLanguage,
    displaying,
    texts,
    start,
    showOriginal: () => {
      operation.current++;
      setWanted(false);
      setFollowing(false);
      intent.current.display = false;
    },
    showTranslation: () => {
      intent.current.display = true;
      setWanted(true);
      setOpen(false);
    },
    cancel: async () => {
      operation.current++;
      setFollowing(false);
      if (client && result) {
        const ticket = epoch.current;
        const action = operation.current;
        const signal = session.current.signal;
        try {
          await client.cancel(result.id);
          if (ticket !== epoch.current || action !== operation.current || signal.aborted) return;
          polling.current?.abort();
          const next = await client.result(result.id, signal);
          if (ticket === epoch.current && action === operation.current && !signal.aborted) {
            setResult(next);
            setFollowing(false);
          }
        } catch (reason) {
          if (ticket === epoch.current && action === operation.current && !signal.aborted)
            setError(translationError(reason));
        } finally {
          // Resume only after the authoritative read settles, including failure.
          // Never overlap that read with a new poll or revive an obsolete session.
          if (ticket === epoch.current && action === operation.current && !signal.aborted)
            refreshPolling((version) => version + 1);
        }
      }
    },
  };
}
export type ReaderTranslationController = ReturnType<typeof useReaderTranslation>;
