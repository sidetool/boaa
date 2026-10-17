import { joinTask } from '../../services/apk-worker/shared-task.mjs';
import type { SourceStreamPort, SourceStreamSession } from './source-stream';

/** Keep only the active episode and one prepared neighbor. No files or library rows are written. */
export class SourceStreamBuffer {
  private sessions = new Map<string, SourceStreamSession>();
  private opening = new Map<string, unknown>();
  private lifetime = new AbortController();
  constructor(private port: SourceStreamPort) {}
  async open(id: string, signal: AbortSignal): Promise<SourceStreamSession> {
    signal.throwIfAborted();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const joined = AbortSignal.any([signal, this.lifetime.signal]);
    return joinTask(this.opening, id, joined, (shared) => this.openSession(id, shared));
  }
  private async openSession(id: string, joined: AbortSignal): Promise<SourceStreamSession> {
    joined.throwIfAborted();
    let raw = await this.port.open(id, joined);
    if (joined.aborted) {
      raw.close();
      joined.throwIfAborted();
    }
    const concurrent = this.sessions.get(id);
    if (concurrent) {
      raw.close();
      return concurrent;
    }
    const cache = new Map<number, Blob>();
    const pendingPages = new Map<string, unknown>();
    const pageControllers = new Map<number, AbortController>();
    const pageVersions = new Map<number, number>();
    const invalidPages = new Set<number>();
    let size = 0;
    const controller = new AbortController();
    let reopening: Promise<void> | undefined;
    const session: SourceStreamSession = {
      pageCount: raw.pageCount,
      initialPosition: raw.initialPosition,
      invalidatePage: (index) => {
        const old = cache.get(index);
        if (old) size -= old.size;
        cache.delete(index);
        pageVersions.set(index, (pageVersions.get(index) ?? 0) + 1);
        pageControllers.get(index)?.abort();
        pendingPages.delete(String(index));
        invalidPages.add(index);
        raw.invalidatePage?.(index);
      },
      loadPage: async (index, request) => {
        const active = AbortSignal.any([request, controller.signal, this.lifetime.signal]);
        active.throwIfAborted();
        const cached = cache.get(index);
        if (cached) {
          cache.delete(index);
          cache.set(index, cached);
          return cached;
        }
        const version = pageVersions.get(index);
        const assertFresh = () => {
          if (pageVersions.get(index) !== version) throw new DOMException('Page invalidated', 'AbortError');
        };
        return joinTask(pendingPages, String(index), active, async (shared) => {
          shared.throwIfAborted();
          assertFresh();
          const pageController = new AbortController();
          pageControllers.set(index, pageController);
          const active = AbortSignal.any([shared, pageController.signal]);
          try {
            let blob: Blob;
            try {
              blob = await raw.loadPage(index, active);
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'source_stream_expired') throw error;
              reopening ??= this.port
                .open(id, controller.signal)
                .then((next) => {
                  if (
                    controller.signal.aborted ||
                    this.lifetime.signal.aborted ||
                    next.pageCount !== session.pageCount
                  ) {
                    next.close();
                    throw new Error('회차 구성이 변경됐습니다. 회차 목록에서 다시 열어 주세요.');
                  }
                  raw.close();
                  raw = next;
                })
                .finally(() => {
                  reopening = undefined;
                });
              await reopening;
              active.throwIfAborted();
              if (invalidPages.has(index)) raw.invalidatePage?.(index);
              blob = await raw.loadPage(index, active);
            }
            active.throwIfAborted();
            assertFresh();
            invalidPages.delete(index);
            const old = cache.get(index);
            if (old) size -= old.size;
            cache.delete(index);
            cache.set(index, blob);
            size += blob.size;
            while (size > 32 * 1024 * 1024 || cache.size > 16) {
              const key = cache.keys().next().value!;
              size -= cache.get(key)!.size;
              cache.delete(key);
            }
            return blob;
          } finally {
            if (pageControllers.get(index) === pageController) pageControllers.delete(index);
          }
        });
      },
      close: () => {
        controller.abort();
        raw.close();
        cache.clear();
        pendingPages.clear();
        pageControllers.clear();
      },
    };
    this.sessions.set(id, session);
    return session;
  }
  retain(ids: readonly string[]) {
    for (const [id, session] of this.sessions)
      if (!ids.includes(id)) {
        session.close();
        this.sessions.delete(id);
      }
  }
  close() {
    this.lifetime.abort();
    this.opening.clear();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
