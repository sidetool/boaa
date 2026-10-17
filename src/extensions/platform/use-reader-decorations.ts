import { useLayoutEffect, type RefObject } from 'react';
import { isUiJson } from '@boaa/extension-contracts/ui-json';
import type { PluginService } from './plugin-service';
import type { ReaderScreenHandle, ReaderScreenModel, ReaderMode } from '../../features/reader/reader-screen-contract';
import type { ReaderViewportApi } from '../../features/reader/ReaderViewport';
/** Reads only cached canonical paragraphs selected by host-owned visible DOM anchors, never guest selectors. */
export function useReaderDecorations(
  service: PluginService | undefined,
  root: RefObject<HTMLElement>,
  api: ReaderViewportApi | undefined,
  model: ReaderScreenModel,
  mode: ReaderMode,
  handle: ReaderScreenHandle,
) {
  const { id: bookId, activeContentRevisionId: contentRevision, format } = model.novel;
  const chapterId = model.chapter.id,
    request = model.openRequestVersion,
    theme = model.settings.theme;
  useLayoutEffect(() => {
    const element = root.current;
    if (
      !service ||
      !element ||
      !api ||
      !contentRevision ||
      !['txt', 'epub'].includes(format ?? '') ||
      !['read', 'listen'].includes(mode)
    )
      return;
    const connection = service.connectReader(handle.decorations.plugins);
    if (!connection) return;
    const key = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const update = () => {
      timer = undefined;
      if (stopped) return;
      const viewport = element.querySelector<HTMLElement>('.reader-viewport-layer.is-active');
      if (!viewport || viewport.closest('[inert],[hidden],[aria-hidden="true"]')) {
        connection.update();
        return;
      }
      if (viewport.dataset.paginationReady === 'false') return;
      const area = viewport.getBoundingClientRect();
      if (area.width <= 0 || area.height <= 0) {
        connection.update();
        return;
      }
      const blocks = new Map<string, { id: string; text: string; textHash: string }>();
      const nearby = new Map<string, { id: string; text: string; textHash: string }>();
      const order = new Map<string, number>();
      for (const node of viewport.querySelectorAll<HTMLElement>('[data-reader-text]')) {
        if (node.closest('[hidden],[inert],[aria-hidden="true"],.reader-paginated-page.is-outgoing')) continue;
        const rect = node.getBoundingClientRect();
        if (
          rect.height <= 0 ||
          rect.width <= 0 ||
          rect.bottom < area.top - area.height ||
          rect.top > area.bottom + area.height ||
          rect.right <= area.left ||
          rect.left >= area.right
        )
          continue;
        const paragraph = api.getCachedParagraphById(node.dataset.readerText!);
        if (
          !paragraph ||
          paragraph.novelId !== bookId ||
          paragraph.chapterId !== chapterId ||
          paragraph.documentKind === 'image' ||
          paragraph.documentKind === 'separator'
        )
          continue;
        const target = rect.bottom > area.top && rect.top < area.bottom ? blocks : nearby;
        order.set(paragraph.id, paragraph.index);
        target.set(paragraph.id, { id: paragraph.id, text: paragraph.text, textHash: paragraph.textHash });
      }
      const batch = { key, bookId, chapterId, contentRevision, theme, blocks: [...blocks.values()] };
      // Visible paragraphs have priority. Nearby context is optional and only fills spare budget.
      // An oversized visible paragraph/batch is rejected as a whole by the runtime.
      for (const block of nearby.values()) {
        if (blocks.has(block.id) || batch.blocks.length >= 64) continue;
        if (isUiJson({ ...batch, blocks: [...batch.blocks, block] }, 48 * 1024)) batch.blocks.push(block);
      }
      batch.blocks.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      connection.update(batch.blocks.length ? batch : undefined);
    };
    const schedule = () => {
      if (!timer && !stopped) timer = setTimeout(update, 60);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-hidden', 'inert', 'hidden', 'data-pagination-ready'],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    element.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      observer.disconnect();
      resize.disconnect();
      element.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      connection.close();
    };
  }, [service, root, api, bookId, chapterId, contentRevision, format, mode, request, theme, handle]);
}
