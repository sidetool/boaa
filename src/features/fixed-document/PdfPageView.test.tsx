import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { DocumentTextBlock } from '../../domain/types';
import { PdfPageView } from './PdfPageView';

afterEach(() => vi.unstubAllGlobals());

it('cancels the previous canvas render on rotation and the active render on unmount', () => {
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  const tasks: { cancel: ReturnType<typeof vi.fn>; promise: Promise<void> }[] = [];
  const render = vi.fn(() => {
    const task = { cancel: vi.fn(), promise: Promise.resolve() };
    tasks.push(task);
    return task;
  });
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render,
  } as unknown as PDFPageProxy;
  const canvas = { getContext: vi.fn(() => ({})), style: {}, width: 0, height: 0 };
  const view = (rotation: number) => (
    <PdfPageView
      page={page}
      pageIndex={0}
      fit="page"
      zoom={1}
      rotation={rotation}
      availableWidth={100}
      availableHeight={200}
    />
  );
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(view(0), { createNodeMock: (node) => (node.type === 'canvas' ? canvas : null) });
  });
  expect(canvas.width).toBe(250); // Device scale remains capped at 2.5.
  act(() => root.update(view(90)));
  expect(tasks[0].cancel).toHaveBeenCalledOnce();
  expect(tasks[1].cancel).not.toHaveBeenCalled();
  act(() => root.unmount());
  expect(tasks[1].cancel).toHaveBeenCalledOnce();
});

it.each([
  [0, 10, 20, 30, 40],
  [90, 40, 10, 40, 30],
  [180, 60, 40, 30, 40],
  [270, 20, 60, 40, 30],
])('keeps text-layer geometry and search/listening marks at rotation %i', (rotation, x, y, width, height) => {
  const block: DocumentTextBlock = {
    id: 'block',
    revisionId: 'revision',
    bookId: 'book',
    pageIndex: 0,
    order: 0,
    role: 'paragraph',
    text: 'Fixture',
    normalizedText: 'fixture',
    direction: 'ltr',
    quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
  };
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(
      <PdfPageView
        pageIndex={0}
        fit="page"
        zoom={1}
        rotation={rotation}
        availableWidth={100}
        availableHeight={200}
        textBlocks={[block]}
        searchQuery="FIXTURE"
        activeRange={{ blockId: block.id, startOffset: 0, endOffset: 3 }}
      />,
    );
  });
  const span = root.root.findByProps({ 'data-document-block-id': 'block' });
  expect(span.props.className).toBe('is-search-hit is-tts-active');
  expect(parseFloat(span.props.style.left)).toBeCloseTo(x);
  expect(parseFloat(span.props.style.top)).toBeCloseTo(y);
  expect(parseFloat(span.props.style.width)).toBeCloseTo(width);
  expect(parseFloat(span.props.style.height)).toBeCloseTo(height);
  act(() => root.unmount());
});
