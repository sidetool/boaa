import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryExternalWorkView } from '../../features/library/library-screen-contract';
import type { LibraryWorkItem } from '../../features/library/library-work-order';
import type { ImportTaskView } from '../../features/import/import-task-projection';
import { model, novel } from '../test-fixtures';
import { WorkTile, type WorkTileProps } from './WorkTile';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function book(finished: boolean): Extract<LibraryWorkItem, { kind: 'book' }> {
  const view = model([novel()]).collection.visibleBooks[0];
  return { kind: 'book', key: 'book:novel-1', book: { ...view, isFinished: finished } };
}

function external(overrides: Partial<LibraryExternalWorkView> = {}): Extract<LibraryWorkItem, { kind: 'external' }> {
  return {
    kind: 'external',
    key: 'external:remote-1',
    work: {
      id: 'remote-1',
      title: '외부 작품',
      availableReleaseCount: 10,
      readReleaseCount: 4,
      newReleaseCount: 0,
      addedAt: '2026-07-01',
      updatedAt: '2026-07-01',
      ...overrides,
    },
  };
}

function mount(item: LibraryWorkItem, overrides: Partial<WorkTileProps> = {}) {
  const props: WorkTileProps = {
    item,
    layout: 'grid',
    progress: { progress: 0.4, percent: 40, subline: '읽는 중' },
    selecting: false,
    selected: false,
    activate: vi.fn(),
    openMenu: vi.fn(),
    ...overrides,
  };
  act(() => {
    renderer = create(<WorkTile {...props} />);
  });
  return { root: renderer!.root, props };
}

describe('WorkTile update badge', () => {
  it.each(['grid', 'compact'] as const)('shows UP with the exact accessible new-release count in %s', (layout) => {
    const { root } = mount(external({ newReleaseCount: 3 }), { layout });
    const badge = root.findByProps({ 'aria-label': '새 회차 3개' });
    expect(badge.children[0]).toBe('UP');
    expect(badge.findByType('small').children).toEqual(['3']);
  });

  it('caps the visual count while preserving the full accessible count', () => {
    const { root } = mount(external({ newReleaseCount: 120 }));
    const badge = root.findByProps({ 'aria-label': '새 회차 120개' });
    expect(badge.children[0]).toBe('UP');
    expect(badge.findByType('small').children).toEqual(['99+']);
  });

  it('omits UP when no new releases exist', () => {
    const { root } = mount(external());
    expect(root.findAll((node) => /^새 회차 \d+개$/.test(node.props['aria-label'] ?? ''))).toHaveLength(0);
    expect(root.findAllByType('span').some((node) => node.children.includes('UP'))).toBe(false);
  });
});

describe('WorkTile finished badge', () => {
  it.each([false, true])('uses the local book isFinished flag (%s), independently of progress', (finished) => {
    const { root } = mount(book(finished), {
      progress: { progress: finished ? 0 : 1, percent: finished ? 0 : 100, subline: '테스트 진행률' },
    });
    const badges = root.findAllByProps({ 'aria-label': '완독' });
    expect(badges).toHaveLength(finished ? 1 : 0);
    if (finished) expect(badges[0].findByType('svg').props.className).toContain('lucide-check');
  });

  it.each([
    [10, 10, true],
    [12, 10, true],
    [9, 10, false],
    [0, 0, false],
    [undefined, 10, false],
  ] as const)(
    'marks external read=%s / available=%s as finished=%s',
    (readReleaseCount, availableReleaseCount, finished) => {
      const { root } = mount(external({ readReleaseCount, availableReleaseCount }));
      const badges = root.findAllByProps({ 'aria-label': '완독' });
      expect(badges).toHaveLength(finished ? 1 : 0);
      if (finished) expect(badges[0].findByType('svg').props.className).toContain('lucide-check');
    },
  );

  it.each(['grid', 'compact'] as const)('shows finished badges on %s covers', (layout) => {
    const { root } = mount(book(true), { layout });
    expect(root.findByProps({ 'aria-label': '완독' })).toBeDefined();
  });

  it.each(['book', 'external'] as const)(
    'hides the %s finished badge during import and restores it afterwards',
    (kind) => {
      const item = kind === 'book' ? book(true) : external({ readReleaseCount: 10 });
      const task: ImportTaskView = {
        id: 'task-1',
        batchId: 'batch-1',
        source: 'external_source',
        title: '가져오는 작품',
        phase: 'downloading',
        percent: 40,
      };
      const { root, props } = mount(item, { task });
      expect(root.findAllByProps({ 'aria-label': '완독' })).toHaveLength(0);
      act(() => {
        renderer!.update(<WorkTile {...props} task={undefined} />);
      });
      expect(root.findByProps({ 'aria-label': '완독' })).toBeDefined();
    },
  );
});

describe('WorkTile long press and context menu', () => {
  function pointer() {
    return { button: 0, clientX: 10, clientY: 20 };
  }
  it('long press calls pick after 450ms and consumes the following click', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { vibrate: vi.fn() });
    const pick = vi.fn();
    const { root, props } = mount(book(false), { pick });
    const tile = root.findByProps({ 'aria-label': '테스트 소설 열기' });
    act(() => tile.props.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(449);
    });
    expect(pick).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pick).toHaveBeenCalledExactlyOnceWith();
    act(() => tile.props.onPointerUp());
    act(() => tile.props.onClick());
    expect(props.activate).not.toHaveBeenCalled();
    expect(props.openMenu).not.toHaveBeenCalled();
    act(() => tile.props.onClick());
    expect(props.activate).toHaveBeenCalledOnce();
  });

  it.each(['onPointerUp', 'onPointerLeave', 'onPointerCancel', 'onPointerMove'] as const)(
    '%s cancels a pending long press',
    (cancel) => {
      vi.useFakeTimers();
      const pick = vi.fn();
      const { root } = mount(book(false), { pick });
      const tile = root.findByProps({ 'aria-label': '테스트 소설 열기' });
      act(() => tile.props.onPointerDown(pointer()));
      act(() => tile.props[cancel]({ clientX: 21, clientY: 20 }));
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(pick).not.toHaveBeenCalled();
    },
  );

  it('right click opens the menu without picking or opening the work', () => {
    vi.useFakeTimers();
    const pick = vi.fn();
    const { root, props } = mount(book(false), { pick });
    const tile = root.findByProps({ 'aria-label': '테스트 소설 열기' });
    const preventDefault = vi.fn();
    act(() => tile.props.onPointerDown(pointer()));
    act(() => tile.props.onContextMenu({ preventDefault }));
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(props.openMenu).toHaveBeenCalledExactlyOnceWith();
    expect(pick).not.toHaveBeenCalled();
    act(() => tile.props.onClick());
    expect(props.activate).not.toHaveBeenCalled();
  });

  it('long press in selection mode activates selection rather than starting it again', () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', {});
    const pick = vi.fn();
    const { root, props } = mount(book(false), { selecting: true, pick });
    act(() => root.findByProps({ 'aria-label': '테스트 소설 선택' }).props.onPointerDown(pointer()));
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(props.activate).toHaveBeenCalledExactlyOnceWith();
    expect(pick).not.toHaveBeenCalled();
    expect(props.openMenu).not.toHaveBeenCalled();
  });
});
