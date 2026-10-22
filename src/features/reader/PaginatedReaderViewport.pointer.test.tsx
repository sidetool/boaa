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

it('keeps a touch turn through child-to-root capture transfer but cancels genuine capture loss', async () => {
  vi.stubGlobal('window', { clearTimeout: vi.fn(), cancelAnimationFrame: vi.fn() });
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
    isActive: false,
  } as unknown as ReaderViewportLayerProps & { onPaginationFailure: () => void };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<PaginatedReaderViewport {...props} />, {
        createNodeMock: () => ({ clientWidth: 390, clientHeight: 700, replaceChildren: vi.fn() }),
      });
    });
    const root = renderer.root.findByType('section');
    const target = {};
    const currentTarget = { hasPointerCapture: vi.fn(() => true) };
    const event = { target, currentTarget, pointerId: 7, clientX: 159 };
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
    act(() => renderer?.unmount());
  }
});
