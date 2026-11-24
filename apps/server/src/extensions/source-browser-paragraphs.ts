import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright-core';

interface RenderedDocument {
  nodes: {
    backendNodeId?: number[];
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
  };
  layout: {
    nodeIndex: number[];
    text: number[];
    styles: number[][];
  };
}

export function renderedParagraphs(document: RenderedDocument, strings: string[], backendNodeId: number): string {
  const { nodes, layout } = document;
  const { backendNodeId: identifiers, parentIndex, nodeType, nodeName } = nodes;
  if (!identifiers || !parentIndex || !nodeType || !nodeName) return '';
  const root = identifiers.indexOf(backendNodeId);
  if (root < 0) return '';

  const hidden = new Set<number>();
  for (const [row, node] of layout.nodeIndex.entries()) {
    if (strings[layout.styles[row]?.[1]] === '0') hidden.add(node);
  }

  for (let ancestor = root; ancestor >= 0; ancestor = parentIndex[ancestor]) {
    if (hidden.has(ancestor)) return '';
  }

  const paragraphs = new Map<number, string[]>();
  let bytes = 0;
  for (const [row, node] of layout.nodeIndex.entries()) {
    const isBreak = strings[nodeName[node]] === 'BR';
    if (!isBreak && nodeType[node] !== 3) continue;
    if (strings[layout.styles[row]?.[0]] !== 'visible') continue;

    let paragraph = -1;
    let ancestor = node;
    // The flattened tree lists parents before children.
    while (ancestor > root && !hidden.has(ancestor)) {
      if (paragraph < 0 && strings[nodeName[ancestor]] === 'P') paragraph = ancestor;
      ancestor = parentIndex[ancestor];
    }
    if (ancestor !== root || paragraph < 0) continue;

    const text = isBreak ? '\n' : (strings[layout.text[row]] ?? '');
    if (!text) continue;
    bytes += Buffer.byteLength(text) + 2;
    if (bytes > 1024 * 1024) throw new Error('source_body_limit');
    const runs = paragraphs.get(paragraph);
    if (runs) runs.push(text);
    else paragraphs.set(paragraph, [text]);
  }
  return [...paragraphs.values()]
    .map((runs) => runs.join('').trim())
    .filter(Boolean)
    .join('\n\n');
}

export async function readRenderedParagraphs(
  context: BrowserContext,
  page: Page,
  chapter: URL,
  selector: string,
  signal: AbortSignal,
): Promise<string> {
  const session = await context.newCDPSession(page);
  const sameChapter = () => {
    const actual = new URL(page.url());
    return actual.origin === chapter.origin && actual.pathname === chapter.pathname && actual.search === chapter.search;
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      if (!sameChapter()) throw new Error('source_redirect_denied');
      const { root } = await session.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (nodeId) {
        const { node } = await session.send('DOM.describeNode', { nodeId, depth: 0 });
        // Only main-frame layout text is returned to the guest. Chromium flattens shadow trees here.
        const { documents, strings } = await session.send('DOMSnapshot.captureSnapshot', {
          computedStyles: ['visibility', 'opacity'],
        });
        const text = documents[0] && renderedParagraphs(documents[0], strings, node.backendNodeId);
        if (!sameChapter()) throw new Error('source_redirect_denied');
        if (text) return text;
      }
      await delay(500, undefined, { signal });
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}
