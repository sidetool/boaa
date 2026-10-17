import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookEnrichmentController } from '../../features/book-enrichment/useBookEnrichmentController';
import type { LibraryManagementController } from '../../features/library/useLibraryManagementController';
import { novel } from '../test-fixtures';
import { UiNextMetadataEditor } from './UiNextMetadataEditor';

// Keep the actual draft hook and enrichment component; render the portal inline in Node.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: ReactNode) => children,
}));
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('document', { body: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
function controller(overrides: Partial<LibraryManagementController> = {}): LibraryManagementController {
  return {
    available: true,
    panel: { kind: 'metadata', book: novel({ author: '기존 작가', tags: ['기존 태그'] }) },
    shelves: [
      { id: 'shelf-1', name: '읽을 책', sortOrder: 0, createdAt: '2026-07-01', updatedAt: '2026-07-01', revision: 1 },
      { id: 'shelf-2', name: '소장할 책', sortOrder: 1, createdAt: '2026-07-01', updatedAt: '2026-07-01', revision: 1 },
    ],
    memberships: [{ id: 'membership-1', shelfId: 'shelf-1', bookId: 'novel-1', createdAt: '2026-07-01' }],
    selectionMode: false,
    selectedBookIds: new Set(),
    busy: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    setActiveShelf: vi.fn(),
    openShelves: vi.fn(),
    openMetadata: vi.fn(),
    confirmDiscard: vi.fn(() => true),
    closePanel: vi.fn(),
    refreshOpenMetadata: vi.fn().mockResolvedValue(undefined),
    startSelection: vi.fn(),
    toggleSelected: vi.fn(),
    selectBooks: vi.fn(),
    clearSelection: vi.fn(),
    createShelf: vi.fn().mockResolvedValue(undefined),
    updateShelf: vi.fn().mockResolvedValue(undefined),
    deleteShelf: vi.fn().mockResolvedValue(undefined),
    setMembership: vi.fn().mockResolvedValue(undefined),
    saveBookDetails: vi.fn().mockResolvedValue(undefined),
    applyBatch: vi.fn().mockResolvedValue(undefined),
    exportSelectedMetadata: vi.fn(),
    ...overrides,
  };
}
function enrichment(): BookEnrichmentController {
  return {
    available: false,
    providers: [],
    candidates: [],
    receipts: [],
    busy: false,
    load: vi.fn().mockResolvedValue(undefined),
    propose: vi.fn().mockResolvedValue(undefined),
    applyMetadata: vi.fn().mockResolvedValue(true),
    applyCover: vi.fn().mockResolvedValue(true),
    reject: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(true),
  };
}
function mount(value = controller()) {
  act(() => {
    renderer = create(<UiNextMetadataEditor controller={value} bookEnrichment={enrichment()} />);
  });
  return { root: renderer!.root, controller: value };
}
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
function field(root: ReactTestInstance, name: string) {
  const label = root
    .findAllByType('label')
    .find((node) =>
      node.children.some((child) => typeof child !== 'string' && child.type === 'span' && text(child) === name),
    );
  if (!label) throw new Error(`Missing field: ${name}`);
  return label.findByType('input');
}
function change(node: ReactTestInstance, value: string) {
  act(() => node.props.onChange({ target: { value } }));
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}

describe('UiNextMetadataEditor draft and save', () => {
  it('renders nothing without a metadata panel', () => {
    mount(controller({ panel: { kind: 'shelves' } }));
    expect(renderer!.toJSON()).toBeNull();
  });
  it.each(['', '   '])('disables saving an empty title (%j)', (title) => {
    const { root, controller: value } = mount();
    expect(button(root, '저장').props.disabled).toBe(true);
    change(field(root, '제목'), title);
    expect(button(root, '저장').props.disabled).toBe(true);
    expect(value.saveBookDetails).not.toHaveBeenCalled();
  });
  it('saves edited fields with the book and unchanged cover', async () => {
    const { root, controller: value } = mount();
    change(field(root, '제목'), '새 제목');
    change(field(root, '작가'), '새 작가');
    change(field(root, '시리즈'), '새 시리즈');
    change(field(root, '권'), '2.5');
    change(field(root, '언어'), 'ko-KR');
    change(root.findByProps({ 'aria-label': '작품 소개' }), '새 소개');
    await click(button(root, '저장'));
    expect(value.saveBookDetails).toHaveBeenCalledExactlyOnceWith(
      value.panel!.kind === 'metadata' ? value.panel!.book : undefined,
      {
        title: '새 제목',
        author: '새 작가',
        seriesTitle: '새 시리즈',
        seriesIndex: 2.5,
        language: 'ko-KR',
        description: '새 소개',
      },
      { kind: 'keep' },
    );
    expect(value.setMembership).not.toHaveBeenCalled();
  });
  it('adds comma-separated tags, removes a tag, and saves the resulting list', async () => {
    const { root, controller: value } = mount();
    change(root.findByProps({ 'aria-label': '추가할 태그' }), '판타지, 모험, 판타지');
    const preventDefault = vi.fn();
    act(() => root.findByType('form').props.onSubmit({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(root.findByProps({ 'aria-label': '추가할 태그' }).props.value).toBe('');
    expect(button(root, '판타지 태그 지우기')).toBeDefined();
    expect(button(root, '모험 태그 지우기')).toBeDefined();
    await click(button(root, '기존 태그 태그 지우기'));
    await click(button(root, '저장'));
    expect(value.saveBookDetails).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'novel-1' }),
      { tags: ['판타지', '모험'] },
      { kind: 'keep' },
    );
  });
  it('toggles shelf chips and persists only membership changes on saving', async () => {
    const { root, controller: value } = mount();
    expect(button(root, '읽을 책').props['aria-pressed']).toBe(true);
    expect(button(root, '소장할 책').props['aria-pressed']).toBe(false);
    await click(button(root, '읽을 책'));
    await click(button(root, '소장할 책'));
    expect(button(root, '읽을 책').props['aria-pressed']).toBe(false);
    expect(button(root, '소장할 책').props['aria-pressed']).toBe(true);
    expect(value.setMembership).not.toHaveBeenCalled();
    await click(button(root, '저장'));
    expect(value.setMembership).toHaveBeenCalledTimes(2);
    expect(value.setMembership).toHaveBeenNthCalledWith(1, 'shelf-1', 'novel-1', false);
    expect(value.setMembership).toHaveBeenNthCalledWith(2, 'shelf-2', 'novel-1', true);
    expect(value.saveBookDetails).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'novel-1' }),
      {},
      { kind: 'keep' },
    );
  });
  it('keeps save and close disabled while busy', () => {
    const { root } = mount(controller({ busy: true }));
    change(field(root, '제목'), '수정한 제목');
    expect(button(root, '저장 중…').props.disabled).toBe(true);
    expect(button(root, '닫기').props.disabled).toBe(true);
  });
});

describe('UiNextMetadataEditor discard confirmation', () => {
  it('closes a clean draft without confirmation', async () => {
    const { root, controller: value } = mount();
    await click(button(root, '닫기'));
    expect(value.confirmDiscard).not.toHaveBeenCalled();
    expect(value.closePanel).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([false, true])('only closes a dirty draft when discard is confirmed (%s)', async (discard) => {
    const { root, controller: value } = mount(controller({ confirmDiscard: vi.fn(() => discard) }));
    change(field(root, '제목'), '저장하지 않은 제목');
    await click(button(root, '닫기'));
    expect(value.confirmDiscard).toHaveBeenCalledExactlyOnceWith('저장하지 않은 책 정보 변경을 버릴까요?');
    expect(value.closePanel).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(value.saveBookDetails).not.toHaveBeenCalled();
  });
});
