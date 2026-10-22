import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageCurl } from './page-curl-renderer';

// DOM ownership contract only. Pixel/gesture behavior is covered in the actual
// ReaderScreen browser probe; this regression must not depend on GPU timing.
function fixture(decode?: () => Promise<void>) {
  const nodes: HTMLElement[] = [];
  const children = new Map<HTMLElement, HTMLElement[]>();
  const rect = {
    left: 46.796875,
    top: 34.390625,
    right: 343.203125,
    bottom: 825.609375,
    width: 296.40625,
    height: 791.21875,
  };
  const element = (textContent = ''): HTMLElement => {
    const node = {
      className: '',
      textContent,
      dataset: {},
      style: {
        visibility: '',
        zIndex: '',
        setProperty(name: string, value: string) {
          Reflect.set(this, name, value);
        },
      },
      classList: { add: vi.fn(), contains: () => false },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      querySelectorAll: (selector: string) =>
        selector === 'img' && textContent && decode ? [{ style: {}, decode }] : [],
      getBoundingClientRect: () => rect,
      cloneNode: () => element(textContent),
      append: (...items: HTMLElement[]) => children.get(node)!.push(...items),
      remove: () => {
        for (const items of children.values()) {
          const index = items.indexOf(node);
          if (index >= 0) items.splice(index, 1);
        }
      },
    } as unknown as HTMLElement;
    children.set(node, []);
    nodes.push(node);
    return node;
  };
  const current = element('Original page A');
  const incoming = element('Next page B');
  const stage = element();
  Object.assign(stage, {
    scrollLeft: 0,
    scrollTop: 0,
    querySelectorAll: (selector: string) => (selector.includes('is-current') ? [current] : [incoming]),
  });
  vi.stubGlobal('getComputedStyle', () => ({ width: '100px', height: '100px' }));
  vi.stubGlobal('document', { createElement: () => element() });
  return { stage, current, incoming, nodes, children };
}

afterEach(() => vi.unstubAllGlobals());

describe('held sheet snapshot ownership', () => {
  it('keeps originals visible until all cloned images decode', async () => {
    const releases: Array<() => void> = [];
    const f = fixture(() => new Promise<void>((resolve) => releases.push(resolve)));
    const r = createPageCurl(f.stage, true, 1)!;
    const overlay = f.children.get(f.stage)![0];
    expect(releases).toHaveLength(3);
    r.draw(0.3, 400, 0);
    r.activate();
    expect(overlay.style.opacity).toBe('0');
    expect(f.current.style.visibility).toBe('');
    releases[0]();
    releases[1]();
    await Promise.resolve();
    r.activate();
    expect(f.current.style.visibility).toBe('');
    releases[2]();
    await r.ready;
    r.activate();
    expect(overlay.style.opacity).toBe('1');
    expect(f.current.style.visibility).toBe('hidden');
    r.destroy();
    expect(f.current.style.visibility).toBe('');
  });

  it('never reveals late decoded clones after destruction', async () => {
    const releases: Array<() => void> = [];
    const f = fixture(() => new Promise<void>((resolve) => releases.push(resolve)));
    const r = createPageCurl(f.stage, false, -1)!;
    r.destroy();
    releases.forEach((resolve) => resolve());
    await r.ready;
    r.activate();
    expect(f.children.get(f.stage)).toEqual([]);
    expect(f.current.style.visibility).toBe('');
    expect(f.incoming.style.visibility).toBe('');
  });

  it.each([true, false])('never swaps the held surfaces for originals at an endpoint (forward %s)', (forward) => {
    const f = fixture();
    const renderer = createPageCurl(f.stage, forward, forward ? 1 : -1)!;
    renderer.activate();
    const overlay = f.children.get(f.stage)![0];
    const surfaces = f.children.get(overlay)!.filter((node) => node.className.includes('reader-curl-piece'));
    const snapshots = f.nodes.filter((node) => node !== f.current && node !== f.incoming && node.textContent);
    const identities = [...snapshots];
    const texts = snapshots.map((node) => node.textContent);
    const nodeCount = f.nodes.length;
    expect(surfaces).toHaveLength(3);
    expect(snapshots).toHaveLength(3);
    for (const progress of [0, 0.3, 0.7, 0.95, 1, 0.985, 1, 0.95, 0.3, 0, 1]) {
      renderer.draw(progress, 464.409375, 124.7);
      expect(f.current.style.visibility).toBe('hidden');
      expect(f.incoming.style.visibility).toBe('hidden');
      expect(overlay.style.visibility).not.toBe('hidden');
      expect(f.current.style.zIndex).toBe('');
      expect(f.incoming.style.zIndex).toBe('');
      expect(snapshots).toEqual(identities);
      expect(f.nodes).toHaveLength(nodeCount);
      expect(snapshots.map((node) => node.textContent)).toEqual(texts);
    }
    // A React content update must not change an already held visual snapshot.
    f.current.textContent = 'Another page after navigation';
    renderer.draw(1, 464.409375, 124.7);
    expect(snapshots.map((node) => node.textContent)).toEqual(texts);
    renderer.destroy();
    expect(f.children.get(f.stage)).toEqual([]);
    expect(f.current.style.visibility).toBe('');
    expect(f.incoming.style.visibility).toBe('');
    expect(f.stage.dataset.turnRenderer).toBeUndefined();
  });
});
