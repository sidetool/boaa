import './page-curl.css';
import { createPageFold, curlPolygon } from './page-curl-geometry';

/** Three frozen surfaces, following StPageFlip's HTMLRender ordering:
 * static sheet, revealed next sheet, folded sheet. Neither page's content nor
 * ownership changes while the pointer is held, including at progress 0/1.
 */
export function createPageCurl(stage: HTMLElement, forward: boolean, direction: 1 | -1) {
  const comic = stage.classList.contains('fixed-doc-viewport');
  const current = [
    ...stage.querySelectorAll<HTMLElement>(comic ? '.is-turn-current > article' : '.reader-paginated-page.is-current'),
  ];
  const incoming = [
    ...stage.querySelectorAll<HTMLElement>(comic ? '.is-turn-preview > article' : '.reader-paginated-page.is-preview'),
  ];
  if (!current.length || !incoming.length) return undefined;
  const sources = forward ? current : incoming;
  const targets = forward ? incoming : current;
  const all = [...current, ...incoming];
  const rects = new Map(all.map((node) => [node, node.getBoundingClientRect()]));
  const stageRect = stage.getBoundingClientRect();
  const left = Math.min(...[...rects.values()].map((r) => r.left));
  const top = Math.min(...[...rects.values()].map((r) => r.top));
  const width = Math.max(...[...rects.values()].map((r) => r.right)) - left;
  const height = Math.max(...[...rects.values()].map((r) => r.bottom)) - top;
  if (width <= 0 || height <= 0) return undefined;
  const overlay = document.createElement('div');
  overlay.className = `reader-page-curl${comic ? ' is-comic' : ''}`;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('inert', '');
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${left - stageRect.left + stage.scrollLeft}px`,
    top: `${top - stageRect.top + stage.scrollTop}px`,
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: 'none',
    opacity: '0',
  });
  const images: HTMLImageElement[] = [];
  const originals = all.map((source) => source.style.visibility);
  const cloneContent = (pages: HTMLElement[]) => {
    const content = document.createElement('div');
    content.className = `reader-curl-content${comic ? ' fixed-doc-pages' : ''}`;
    Object.assign(content.style, { position: 'absolute', inset: '0', padding: '0', minHeight: '0' });
    // Fit/crop/color variables belong to each comic page group, not the stage.
    const groupStyle = comic ? pages[0].parentElement?.style : undefined;
    if (groupStyle)
      for (const name of groupStyle)
        if (name.startsWith('--')) content.style.setProperty(name, groupStyle.getPropertyValue(name));
    for (const source of pages) {
      const copy = source.cloneNode(true) as HTMLElement;
      const rect = rects.get(source)!;
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
      copy
        .querySelectorAll('input,button,select,textarea,a,[tabindex]')
        .forEach((node) => node.setAttribute('tabindex', '-1'));
      const sourceImages = source.querySelectorAll('img');
      copy.querySelectorAll('img').forEach((image, index) => {
        images.push(image);
        image.loading = 'eager';
        const computed = getComputedStyle(sourceImages[index]);
        Object.assign(image.style, {
          width: computed.width,
          height: computed.height,
          maxWidth: 'none',
          maxHeight: 'none',
        });
      });
      copy.classList.add('reader-curl-copy');
      Object.assign(copy.style, {
        position: 'absolute',
        left: `${rect.left - left}px`,
        top: `${rect.top - top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        bottom: 'auto',
        margin: '0',
        transform: 'none',
        boxSizing: 'border-box',
        visibility: 'visible',
        opacity: '1',
        animation: 'none',
        transition: 'none',
      });
      content.append(copy);
    }
    return content;
  };
  const surface = (kind: string, pages: HTMLElement[]) => {
    const node = document.createElement('div');
    node.className = `reader-curl-piece ${kind}`;
    node.append(cloneContent(pages));
    overlay.append(node);
    return node;
  };
  surface('is-front', sources);
  const revealed = surface('is-revealed', targets);
  const castClip = document.createElement('div');
  castClip.className = 'reader-curl-cast-clip';
  const cast = document.createElement('div');
  cast.className = 'reader-curl-cast';
  castClip.append(cast);
  overlay.append(castClip);
  const back = surface('is-back', sources);
  const paper = document.createElement('div');
  paper.className = 'reader-curl-shade';
  back.append(paper);
  let fold: ReturnType<typeof createPageFold> | undefined;
  let destroyed = false;
  let decoded = images.length === 0;
  // A cached source is not proof that newly cloned image nodes can paint. Keep
  // the original sheet visible until every snapshot has decoded. Opacity hides
  // the entire subtree, including copies with explicit visibility: visible.
  stage.append(overlay);
  stage.dataset.turnRenderer = 'curl';
  const ready = images.length
    ? Promise.all(images.map((image) => image.decode())).then(() => {
        decoded = true;
      })
    : undefined;
  return {
    ready,
    activate() {
      if (destroyed || !decoded) return;
      all.forEach((source) => {
        source.style.visibility = 'hidden';
      });
      overlay.style.opacity = '1';
    },
    width,
    height,
    top: top - stageRect.top,
    draw(progress: number, originY: number, pullY: number) {
      fold ??= createPageFold(width, height, originY, forward ? direction : direction === 1 ? -1 : 1);
      const geometry = fold(forward ? progress : 1 - progress, pullY);
      revealed.style.clipPath = curlPolygon(geometry.revealed);
      back.style.clipPath = curlPolygon(geometry.folded.polygon);
      back.style.transform = `matrix(${geometry.folded.matrix.join(',')})`;
      const shadow = geometry.shadow;
      castClip.style.clipPath = revealed.style.clipPath;
      cast.style.opacity = shadow ? String(shadow.opacity) : '0';
      if (shadow)
        cast.style.transform = `translate(${shadow.x}px, ${shadow.y - height / 2}px) rotate(${shadow.angle}rad)`;
    },
    destroy() {
      destroyed = true;
      overlay.remove();
      all.forEach((source, index) => {
        source.style.visibility = originals[index];
      });
      delete stage.dataset.turnRenderer;
    },
  };
}
