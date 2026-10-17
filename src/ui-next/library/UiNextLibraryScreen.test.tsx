import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actions, model, novel } from '../test-fixtures';
import { createUiNextNavigation } from '../shell/navigation';
import { createUiNextLibraryAdapter } from './model';
import { UiNextLibraryScreen } from './UiNextLibraryScreen';

// react-test-renderer has no DOM portal container. Keep the real sheet and its actions,
// rendering its portal inline while supplying only the browser APIs its effects use.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('document', {
    activeElement: null,
    documentElement: { style: { overflow: '' } },
    body: {},
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function text(node: ReactTestInstance): string {
  if (node.props['aria-hidden']) return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

// Resolve the roles and accessible names used here, ignoring decorative SVGs.
function byRole(root: ReactTestInstance, role: string, name: string | RegExp): ReactTestInstance {
  return root.find((node) => {
    if (typeof node.type !== 'string') return false;
    if ((node.props.role ?? (node.type === 'button' ? 'button' : undefined)) !== role) return false;
    const label: string = node.props['aria-label'] ?? text(node).replace(/\s+/g, ' ').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
}

function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  act(() => node.props.onClick());
}

function mount(screenModel = model([novel()]), bookActions: Partial<ReturnType<typeof actions>['books']> = {}) {
  const screenActions = actions();
  Object.assign(screenActions.books, bookActions);
  const props = { model: screenModel, actions: screenActions };
  act(() => {
    renderer = create(
      <UiNextLibraryScreen
        {...props}
        navigation={createUiNextNavigation(props, 'library', 0, vi.fn())}
        adapter={createUiNextLibraryAdapter(props)}
      />,
    );
  });
  return { ...props, root: renderer!.root };
}

describe('UiNextLibraryScreen actions', () => {
  it.each([
    ['전체', 'all'],
    ['읽는 중', 'reading'],
    ['완독', 'finished'],
    ['안 읽음', 'unread'],
  ] as const)('routes the %s reading-state tab to setFilter(%s)', (label, filter) => {
    const { root, actions } = mount();
    const tabs = byRole(root, 'tablist', '읽기 상태');
    click(byRole(tabs, 'tab', new RegExp(`^${label}\\s*\\d+$`)));
    expect(actions.controls.setFilter).toHaveBeenCalledExactlyOnceWith(filter);
  });

  it.each([
    ['all', 'favorite'],
    ['favorite', 'all'],
  ] as const)('toggles the favorite chip from %s to %s', (filter, nextFilter) => {
    const { root, actions } = mount(model([novel()], { filter }));
    const shelves = byRole(root, 'toolbar', '책장');
    const chip = byRole(shelves, 'button', /^즐겨찾기\s*\d+$/);
    expect(chip.props['aria-pressed']).toBe(filter === 'favorite');
    click(chip);
    expect(actions.controls.setFilter).toHaveBeenCalledExactlyOnceWith(nextFilter);
  });

  it.each([false, true])('routes the shelf chip to setShelf (already active: %s)', (active) => {
    const screenModel = model([novel()]);
    const shelf = {
      id: 'shelf-1',
      name: '내 책장',
      sortOrder: 0,
      createdAt: '2026-07-01',
      updatedAt: '2026-07-01',
      revision: 1,
    };
    screenModel.management.shelves = [shelf];
    screenModel.management.activeShelfId = active ? shelf.id : undefined;
    const { root, actions } = mount(screenModel);
    const chip = byRole(byRole(root, 'toolbar', '책장'), 'button', /^내 책장\s*\d+$/);
    expect(chip.props['aria-pressed']).toBe(active);
    click(chip);
    expect(actions.controls.setShelf).toHaveBeenCalledExactlyOnceWith(active ? undefined : shelf.id);
  });

  it('opens file import from the import sheet and closes it', () => {
    const { root, actions } = mount();
    click(byRole(root, 'button', '가져오기'));
    expect(actions.header.openImport).not.toHaveBeenCalled();
    const sheet = byRole(root, 'dialog', '서재에 추가');
    click(byRole(sheet, 'button', /^파일 가져오기/));
    expect(actions.header.openImport).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each([
    ['최근 읽은 순', 'recent'],
    ['최근 추가한 순', 'added'],
    ['제목순', 'title'],
  ] as const)('routes the %s sort entry to setSort(%s)', (label, sort) => {
    const { root, actions } = mount();
    click(byRole(root, 'button', '정렬과 관리'));
    const sheet = byRole(root, 'dialog', '정렬과 관리');
    click(byRole(sheet, 'menuitemradio', label));
    expect(actions.controls.setSort).toHaveBeenCalledExactlyOnceWith(sort);
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('starts selection from the management sheet', () => {
    const { root, actions } = mount();
    click(byRole(root, 'button', '정렬과 관리'));
    click(byRole(byRole(root, 'dialog', '정렬과 관리'), 'button', '여러 개 선택'));
    expect(actions.controls.startSelection).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('moves the chosen book to trash from its more menu', () => {
    const first = novel();
    const chosen = novel({ id: 'novel-2', title: '다른 작품' });
    const { root, actions } = mount(model([first, chosen]));
    click(byRole(root, 'button', `${chosen.title} 더보기`));
    expect(actions.books.remove).not.toHaveBeenCalled();
    click(byRole(byRole(root, 'dialog', chosen.title), 'button', '휴지통으로 이동'));
    expect(actions.books.remove).toHaveBeenCalledExactlyOnceWith(chosen);
    expect(actions.books.open).not.toHaveBeenCalled();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('toggles the clicked book in selection mode without opening it', () => {
    const book = novel();
    const screenModel = model([book]);
    screenModel.management.selectionMode = true;
    const { root, actions } = mount(screenModel);
    const select = byRole(root, 'button', `${book.title} 선택`);
    expect(select.props['aria-pressed']).toBe(false);
    click(select);
    expect(actions.books.toggleSelected).toHaveBeenCalledExactlyOnceWith(book);
    expect(actions.books.open).not.toHaveBeenCalled();
    click(byRole(root, 'button', '선택 끝내기'));
    expect(actions.controls.clearSelection).toHaveBeenCalledExactlyOnceWith();
  });

  it('opens file import directly from an empty library', () => {
    const { root, actions } = mount(model([]));
    click(byRole(root, 'button', '파일 가져오기'));
    expect(actions.header.openImport).toHaveBeenCalledExactlyOnceWith();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });
});

describe('library gestures and trash', () => {
  it.each(['book', 'external'] as const)('long press starts selection and picks only the chosen %s', (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { vibrate: vi.fn() });
    const chosen = novel({ id: 'chosen', title: '고른 작품' });
    const screenModel = model(kind === 'book' ? [novel(), chosen] : []);
    if (kind === 'external')
      screenModel.externalSources.libraryWorks = [
        {
          id: 'remote',
          title: chosen.title,
          availableReleaseCount: 10,
          newReleaseCount: 0,
          addedAt: '2026-07-01',
          updatedAt: '2026-07-02',
        },
      ];
    if (kind === 'external') screenModel.collection.totalBooks = 1;
    const toggleExternal = vi.fn();
    const { root, actions } = mount(screenModel, { toggleSelectedExternal: toggleExternal });
    const tile = byRole(root, 'button', `${chosen.title} 열기`);
    act(() => tile.props.onPointerDown({ button: 0, clientX: 12, clientY: 20 }));
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(actions.controls.startSelection).toHaveBeenCalledExactlyOnceWith();
    if (kind === 'book') {
      expect(actions.books.toggleSelected).toHaveBeenCalledExactlyOnceWith(chosen);
      expect(vi.mocked(actions.controls.startSelection).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(actions.books.toggleSelected).mock.invocationCallOrder[0],
      );
      expect(toggleExternal).not.toHaveBeenCalled();
    } else {
      expect(toggleExternal).toHaveBeenCalledExactlyOnceWith('remote');
      expect(vi.mocked(actions.controls.startSelection).mock.invocationCallOrder[0]).toBeLessThan(
        toggleExternal.mock.invocationCallOrder[0],
      );
      expect(actions.books.toggleSelected).not.toHaveBeenCalled();
    }
    click(tile);
    expect(actions.books.open).not.toHaveBeenCalled();
    expect(actions.books.openExternal).not.toHaveBeenCalled();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it('right click opens the work menu without selecting or reading', () => {
    const chosen = novel();
    const { root, actions } = mount();
    const preventDefault = vi.fn();
    act(() => byRole(root, 'button', `${chosen.title} 열기`).props.onContextMenu({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(byRole(root, 'dialog', chosen.title)).toBeDefined();
    expect(byRole(root, 'button', '휴지통으로 이동')).toBeDefined();
    expect(actions.controls.startSelection).not.toHaveBeenCalled();
    expect(actions.books.open).not.toHaveBeenCalled();
  });

  it('places the trash tab last and routes it to setFilter(trash)', () => {
    const { root, actions } = mount();
    const tabs = byRole(root, 'tablist', '읽기 상태').findAllByProps({ role: 'tab' });
    expect(tabs.map((tab) => text(tab).replace(/\s*\d+$/, ''))).toEqual([
      '전체',
      '읽는 중',
      '완독',
      '안 읽음',
      '휴지통',
    ]);
    click(tabs.at(-1)!);
    expect(actions.controls.setFilter).toHaveBeenCalledExactlyOnceWith('trash');
  });

  it.each(['book', 'external'] as const)('tapping a trashed %s offers restore and permanent delete', (kind) => {
    const chosen = novel({ title: '지운 작품', deletedAt: '2026-10-17T00:00:00Z' });
    const screenModel = model([chosen], { filter: 'trash' });
    screenModel.collection.visibleBooks =
      kind === 'book' ? [{ ...model([novel()]).collection.visibleBooks[0], novel: chosen }] : [];
    if (kind === 'external')
      screenModel.externalSources.libraryWorks = [
        {
          id: 'remote',
          title: chosen.title,
          availableReleaseCount: 10,
          newReleaseCount: 0,
          addedAt: '2026-07-01',
          updatedAt: '2026-07-02',
          deletedAt: chosen.deletedAt,
        },
      ];
    const restoreExternal = vi.fn(),
      purgeExternal = vi.fn();
    const { root, actions } = mount(screenModel, { restoreExternal, purgeExternal });
    const openMenu = () => click(byRole(root, 'button', `${chosen.title} 열기`));
    openMenu();
    const sheet = byRole(root, 'dialog', chosen.title);
    expect(sheet.findAllByType('button').map(text)).toContain('복원');
    expect(sheet.findAllByType('button').map(text)).toContain('영구 삭제');
    click(byRole(sheet, 'button', '복원'));
    expect(kind === 'book' ? actions.books.restore : restoreExternal).toHaveBeenCalledExactlyOnceWith(
      kind === 'book' ? chosen : 'remote',
    );
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    openMenu();
    click(byRole(byRole(root, 'dialog', chosen.title), 'button', '영구 삭제'));
    expect(kind === 'book' ? actions.books.purge : purgeExternal).toHaveBeenCalledExactlyOnceWith(
      kind === 'book' ? chosen : 'remote',
    );
    expect(actions.books.open).not.toHaveBeenCalled();
    expect(actions.books.openExternal).not.toHaveBeenCalled();
  });
});

it.each([0, 1])('uses the controller total once with %i currently visible streaming works', (visible) => {
  const screenModel = model([novel()]);
  screenModel.collection.totalBooks = 3;
  screenModel.externalSources.libraryWorks = visible
    ? [
        {
          id: 'stream',
          title: '스트림',
          addedAt: '2026-09-01',
          updatedAt: '2026-09-30',
          availableReleaseCount: 10,
          newReleaseCount: 0,
        },
      ]
    : [];
  const { root } = mount(screenModel);
  expect(text(root.findByProps({ className: 'un-library-title' }))).toBe('서재 3');
});
