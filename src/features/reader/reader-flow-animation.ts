import { createPageCurl } from './page-curl-renderer';
import type { ReaderAnchor, ReaderSettings } from '../../domain/types';

/** Freeze the visible scroll frame and the prepared destination. Flow changes
 * have no source page boundary, so animating an adjacent cached page would repeat
 * or skip text. Use the actual displayed frame instead, with the same curl renderer. */
export async function animateReaderFlow(
  container: HTMLElement,
  motion: ReaderSettings['readingProfile']['pageTurnMotion'],
  direction: -1 | 1,
  signal: AbortSignal,
  destination?: ReaderAnchor,
): Promise<void> {
  if (motion === 'instant' || signal.aborted || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const deadline = performance.now() + 3000;
  // seek resolves after state is queued, not after React commits the new page.
  // Match its identity before taking a snapshot (one RAF is not a DOM fence).
  while (!signal.aborted) {
    const page = container.querySelector<HTMLElement>(
      '[data-reader-layer="paginated"] .reader-paginated-page.is-current',
    );
    const root = container.querySelector<HTMLElement>('[data-reader-layer="paginated"]');
    if (
      root?.dataset.paginationReady === 'true' &&
      (!destination ||
        (page?.dataset.pageStartId === destination.blockId &&
          Number(page.dataset.pageStartOffset) === destination.offset &&
          Number(page.dataset.pageStartIndex) === destination.blockIndex))
    )
      break;
    if (performance.now() >= deadline) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const frame = requestAnimationFrame(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  if (signal.aborted) return;
  const source = container.querySelector<HTMLElement>('[data-reader-layer="scroll"]');
  const target = container.querySelector<HTMLElement>('[data-reader-layer="paginated"]');
  if (!source || !target) return;
  const stage = document.createElement('div');
  stage.className = 'reader-flow-animation';
  stage.setAttribute('aria-hidden', 'true');
  stage.setAttribute('inert', '');
  Object.assign(stage.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '3',
    overflow: 'hidden',
    pointerEvents: 'none',
  });
  const sheet = (root: HTMLElement, scroll: boolean) => {
    const frame = document.createElement('div');
    Object.assign(frame.style, { position: 'absolute', inset: '0', overflow: 'hidden' });
    const copy = root.cloneNode(true) as HTMLElement;
    if (scroll) {
      const bounds = root.getBoundingClientRect();
      const rows = root.querySelectorAll<HTMLElement>(':scope > .reader-document .reader-virtual-row');
      copy.querySelectorAll<HTMLElement>(':scope > .reader-document .reader-virtual-row').forEach((row, index) => {
        const rect = rows[index].getBoundingClientRect();
        if (rect.bottom < bounds.top || rect.top > bounds.bottom) row.remove();
      });
    }
    copy.classList.remove('is-page-host', 'is-inactive', 'is-opening');
    copy.classList.add('is-active');
    copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    copy
      .querySelectorAll(
        scroll
          ? '.reader-paginated-root, .reader-auto-reading-overlay'
          : '.reader-pagination-measure, .reader-auto-reading-overlay',
      )
      .forEach((node) => node.remove());
    Object.assign(copy.style, {
      position: 'absolute',
      inset: '0',
      margin: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    copy.style.setProperty('visibility', 'visible', 'important');
    frame.append(copy);
    stage.append(frame);
    return { frame, copy, offset: root.scrollTop };
  };
  const before = sheet(source, true);
  const after = sheet(target, false);
  // Keep the real scroll frame visible while snapshot images decode.
  stage.style.opacity = '0';
  container.append(stage);
  before.copy.scrollTop = before.offset;
  let curl: ReturnType<typeof createPageCurl>;
  let frameId = 0;
  const cleanup = () => {
    cancelAnimationFrame(frameId);
    curl?.destroy();
    stage.remove();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  const waitForImages = async (ready?: Promise<unknown>) => {
    if (!ready) return;
    let finish!: () => void;
    let timer: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener('abort', finish, { once: true });
      timer = setTimeout(resolve, 3000);
    });
    let decoded = false;
    try {
      await Promise.race([
        ready.then(() => {
          decoded = true;
        }),
        interrupted,
      ]);
      if (!decoded || signal.aborted) throw new Error('Reader flow snapshot cancelled');
    } finally {
      clearTimeout(timer!);
      signal.removeEventListener('abort', finish);
    }
  };
  let completed = false;
  try {
    const images = [...stage.querySelectorAll('img')];
    await waitForImages(
      Promise.all(
        images.map((image) => {
          image.loading = 'eager';
          return image.decode();
        }),
      ),
    );
    if (signal.aborted) return;
    if (motion === 'page') {
      curl = createPageCurl(stage, direction > 0, direction, { current: [before.frame], incoming: [after.frame] });
      await waitForImages(curl?.ready);
      if (signal.aborted) return;
      curl?.draw(0, curl.height * 0.8, 0);
      curl?.activate();
    }
    const draw = (p: number) => {
      if (curl) curl.draw(p, curl.height * 0.8, 0);
      else {
        const axis = motion === 'smooth' ? 'Y' : 'X';
        before.frame.style.transform = `translate${axis}(${-direction * p * 100}%)`;
        after.frame.style.transform = `translate${axis}(${direction * (1 - p) * 100}%)`;
      }
    };
    draw(0);
    stage.style.opacity = '1';
    await new Promise<void>((resolve) => {
      let start: number | undefined;
      const abort = () => resolve();
      signal.addEventListener('abort', abort, { once: true });
      const tick = (now: number) => {
        start ??= now;
        const p = Math.min(1, (now - start) / (motion === 'page' ? 340 : 180));
        draw(1 - (1 - p) ** 3);
        if (p < 1 && !signal.aborted) frameId = requestAnimationFrame(tick);
        else {
          signal.removeEventListener('abort', abort);
          resolve();
        }
      };
      frameId = requestAnimationFrame(tick);
    });
    completed = !signal.aborted;
  } finally {
    // Keep the endpoint until React reveals the prepared destination. Its owner
    // aborts this snapshot in that commit, so the old scroll frame cannot flash.
    if (!completed) {
      signal.removeEventListener('abort', cleanup);
      cleanup();
    }
  }
}
