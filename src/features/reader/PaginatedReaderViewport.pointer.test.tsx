import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import { PaginatedReaderViewport } from './PaginatedReaderViewport';
import { ReaderScreenHandle } from './reader-screen-contract';
import type { ReaderViewportLayerProps } from './ReaderViewport';

const turn = vi.hoisted(() => ({
  preview: undefined,
  active: false,
  cancel: vi.fn(),
  up: vi.fn(() => true),
  down: vi.fn(),
  move: vi.fn(() => true),
  turn: vi.fn(),
}));
vi.mock('./use-page-turn', () => ({ usePageTurn: () => turn }));
vi.mock('./use-reader-progress', () => {
  const persistence = { schedule: vi.fn(), flush: vi.fn(async () => undefined) };
  return { useReaderPositionPersistence: () => persistence };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mountViewport() {
  vi.stubGlobal('window', { clearTimeout: vi.fn(), cancelAnimationFrame: vi.fn(), requestAnimationFrame: vi.fn() });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { fonts: { ready: Promise.resolve() } }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const chapter = testChapter(1);
  const props = {
    novel: testNovel(),
    chapter,
    chapters: [chapter],
    repository: {},
    settings: defaultSettings,
    mode: 'read',
    search: { highlightQuery: '' },
    screenHandle: new ReaderScreenHandle(),
    apiRef: {},
    onApiReady: vi.fn(),
    onVisualLocation: vi.fn(),
    onPaginationFailure: vi.fn(),
    onScrollIntent: vi.fn(),
    isActive: false,
  } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PaginatedReaderViewport {...props} />, {
      createNodeMock: () => ({ clientWidth: 390, clientHeight: 700, replaceChildren: vi.fn() }),
    });
  });
  return { renderer, props, root: renderer.root.findByType('section') };
}

it('does not replay wheel input after capture handed ownership to native scrolling', async () => {
  const { renderer, props, root } = await mountViewport();
  try {
    await act(async () => {
      root.props.onWheel({ deltaY: -60, deltaX: 0, ctrlKey: false });
    });
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(props.onScrollIntent).not.toHaveBeenCalled();
  } finally {
    act(() => renderer.unmount());
  }
});

it('keeps a touch turn through child-to-root capture transfer but cancels genuine capture loss', async () => {
  const { renderer, root } = await mountViewport();
  try {
    const target = {};
    const currentTarget = { hasPointerCapture: vi.fn(() => true) };
    const event = { target, currentTarget, pointerId: 7, clientX: 159, stopPropagation: vi.fn() };
    act(() => root.props.onLostPointerCapture(event));
    expect(turn.up).not.toHaveBeenCalled();
    act(() => root.props.onPointerUp({ ...event, currentTarget: { hasPointerCapture: () => false } }));
    expect(turn.up).toHaveBeenLastCalledWith(7, 159);

    turn.up.mockClear();
    act(() => root.props.onLostPointerCapture({ ...event, target: currentTarget }));
    expect(turn.up).toHaveBeenLastCalledWith(7, 159, true);
    turn.up.mockClear();
    currentTarget.hasPointerCapture.mockReturnValue(false);
    act(() => root.props.onLostPointerCapture(event));
    expect(turn.up).toHaveBeenLastCalledWith(7, 159, true);
  } finally {
    act(() => renderer.unmount());
  }
});
