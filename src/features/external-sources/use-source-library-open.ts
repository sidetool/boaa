import { sourceChapterOpenOptions } from './source-chapter-open-options';
import type { OpenReaderChapterOptions } from '../reader/reader-screen-contract';
import { useEffect, useRef, useState } from 'react';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { Chapter, Novel } from '../../domain/types';
import { externalItemKeyId } from '../../external-sources/contracts';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './external-source-controller-contract';
import { externalItemSectionId } from './serial-work-projection';
import { useSourceCommandScope } from './use-source-command-scope';
import { useStreamSaveQueue } from './use-stream-save-queue';

export interface SourceLibraryPending {
  readonly chapterId: string;
  readonly title: string;
  readonly phase: 'importing' | 'opening';
}
/** One serial import lane shared by prefetch and explicit navigation. No background task opens a reader. */
export function useSourceLibraryOpen(input: {
  options: UseExternalSourceControllerOptions;
  importItems(
    items: readonly ExternalSourceItemView[],
    reportRejection?: boolean,
    detached?: boolean,
    silentSuccess?: boolean,
  ): Promise<void>;
  canOpen(): boolean;
  /** Wait for the importer to become idle instead of dropping a background request. */
  canImport?(): boolean;
  prepare(novel: Novel, item: ExternalSourceItemView, chapters: Chapter[]): Promise<void>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const { owner, capture } = useSourceCommandScope(input.options);
  const imports = useStreamSaveQueue<{
    key: string;
    item: ExternalSourceItemView;
    valid(): boolean;
  }>({
    key: (request) => request.key,
    ready: (request) => !request.valid() || (latest.current.canImport?.() ?? true),
    save: async (request) => {
      if (!request.valid()) return;
      // A batch may have saved this episode while admission was blocked.
      const options = latest.current.options;
      const link = (await options.state.listLinks(request.item.key.connectorId)).find(
        (entry) => !entry.pendingImport && externalItemKeyId(entry.source) === externalItemKeyId(request.item.key),
      );
      if (
        link &&
        (await options.listChapters(link.localBookId)).some(
          (chapter) => chapter.documentSectionId === externalItemSectionId(request.item),
        )
      )
        return;
      if (request.valid()) await latest.current.importItems([request.item], true, true, true);
    },
  });
  const { cancel } = imports;
  useEffect(() => cancel, [owner, cancel]);
  const opening = useRef(false);
  const [openingItemKey, setOpeningItemKey] = useState<string>();
  const [pending, setPending] = useState<SourceLibraryPending>();
  const lane = useRef(Promise.resolve());
  const jobs = useRef(new Map<string, Promise<{ novel: Novel; chapters: Chapter[] } | undefined>>());
  const prepared = useRef(
    new Map<
      string,
      {
        value: { novel: Novel; chapters: Chapter[] };
        valid(): boolean;
        revision: UseExternalSourceControllerOptions['libraryRevision'];
      }
    >(),
  );
  const ensure = (item: ExternalSourceItemView, consumePrepared = false) => {
    const current = latest.current;
    const owner = capture();
    const connection = current.options.registry.getExternalSourceStatus(
      item.key.connectorId as ExtensionContributionId,
      current.options.hostContext,
    );
    const key = JSON.stringify([
      current.options.settingsScope,
      current.options.extensionRevision,
      connection,
      item.key,
      item.remoteRevision,
    ]);
    const cached = prepared.current.get(key);
    if (consumePrepared) {
      prepared.current.delete(key);
      if (cached && cached.valid() && cached.revision === current.options.libraryRevision)
        return Promise.resolve(cached.value);
    }
    const existing = jobs.current.get(key);
    if (existing) return existing;
    const valid = () =>
      owner() &&
      JSON.stringify(connection) ===
        JSON.stringify(
          latest.current.options.registry.getExternalSourceStatus(
            item.key.connectorId as ExtensionContributionId,
            latest.current.options.hostContext,
          ),
        );
    const job = lane.current.then(async () => {
      if (!valid()) return;
      const findLink = async () =>
        (await current.options.state.listLinks(item.key.connectorId)).find(
          (link) => !link.pendingImport && externalItemKeyId(link.source) === externalItemKeyId(item.key),
        );
      let link = await findLink();
      const readSnapshot = (bookId: string): Promise<[Chapter[], Novel | undefined]> =>
        Promise.all([current.options.listChapters(bookId), current.options.getNovel(bookId)]);
      let [chapters, novel] = link
        ? await readSnapshot(link.localBookId)
        : ([[], undefined] as [Chapter[], Novel | undefined]);
      if (!valid()) return;
      if (!link || !chapters.some((chapter) => chapter.documentSectionId === externalItemSectionId(item))) {
        await imports.enqueue({ key, item, valid });
        if (!valid()) return;
        link = await findLink();
        [chapters, novel] = link ? await readSnapshot(link.localBookId) : [[], undefined];
      }
      if (!link || !valid() || !chapters.some((chapter) => chapter.documentSectionId === externalItemSectionId(item)))
        return;
      const value = novel && !novel.deletedAt && valid() ? { novel, chapters } : undefined;
      if (value && !consumePrepared) {
        prepared.current.set(key, {
          value,
          valid,
          revision: latest.current.options.libraryRevision,
        });
        while (prepared.current.size > 4) prepared.current.delete(prepared.current.keys().next().value!);
      }
      return value;
    });
    jobs.current.set(key, job);
    lane.current = job.then(
      () => undefined,
      () => undefined,
    );
    void job
      .finally(() => {
        if (jobs.current.get(key) === job) jobs.current.delete(key);
      })
      .catch(() => undefined);
    return job;
  };
  const prefetch = async (item: ExternalSourceItemView) => {
    const active = capture();
    const saved = await ensure(item);
    const chapter = saved?.chapters.find((chapter) => chapter.documentSectionId === externalItemSectionId(item));
    if (saved && chapter && active()) latest.current.options.prefetchChapter?.(saved.novel, chapter);
  };
  const open = async (item: ExternalSourceItemView, readerOptions?: OpenReaderChapterOptions) => {
    const current = latest.current;
    const active = capture();
    if (readerOptions?.navigationSignal?.aborted || opening.current || !active() || !item.release) return false;
    opening.current = true;
    setOpeningItemKey(externalItemKeyId(item.key));
    const target = { chapterId: `source-pending:${externalItemSectionId(item)}`, title: item.release.title };
    setPending({ ...target, phase: 'importing' });
    const valid = () =>
      !readerOptions?.navigationSignal?.aborted &&
      active() &&
      latest.current.canOpen() &&
      (!current.options.readingTarget ||
        JSON.stringify(current.options.readingTarget) === JSON.stringify(latest.current.options.readingTarget));
    try {
      const saved = await ensure(item, true);
      prepared.current.clear();
      if (!saved || !valid()) return false;
      const { novel, chapters } = saved;
      setPending({
        ...target,
        chapterId:
          chapters.find((chapter) => chapter.documentSectionId === externalItemSectionId(item))?.id ?? target.chapterId,
        phase: 'opening',
      });
      await latest.current.prepare(novel, item, chapters);
      if (!valid()) return false;
      await current.options.openNovel(novel, {
        documentSectionId: externalItemSectionId(item),
        documentSectionTitle: item.release.title,
        chapters,
        ...(readerOptions
          ? {
              readerOptions: sourceChapterOpenOptions(
                readerOptions,
                chapters.find((chapter) => chapter.documentSectionId === externalItemSectionId(item))!,
              ),
            }
          : {}),
      });
      return !readerOptions?.navigationSignal?.aborted;
    } finally {
      opening.current = false;
      if (active()) {
        setOpeningItemKey(undefined);
        setPending(undefined);
      }
    }
  };
  return { open, prefetch, openingItemKey, pending };
}
