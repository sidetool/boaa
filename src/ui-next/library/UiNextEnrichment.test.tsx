import type { ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
  BookEnrichmentProvenance,
  BookEnrichmentProviderSummary,
} from '../../features/book-enrichment/book-enrichment-contract';
import type { BookEnrichmentController } from '../../features/book-enrichment/useBookEnrichmentController';
import { novel } from '../test-fixtures';
import { UiNextEnrichment } from './UiNextEnrichment';

type Props = ComponentProps<typeof UiNextEnrichment>;
const provenance: BookEnrichmentProvenance = {
  extensionId: 'trusted.catalog',
  extensionVersion: '1.0.0',
  contributionId: 'trusted.catalog.books',
  origin: 'bundled_trusted',
  registrationFingerprint: 'fixture-registration',
  sourceFingerprints: [],
  generatedAt: '2026-07-01T00:00:00.000Z',
};
function provider(id = provenance.contributionId): BookEnrichmentProviderSummary {
  return {
    extensionId: provenance.extensionId,
    extensionVersion: '1.0.0',
    descriptor: { id, schemaVersion: 1, title: id, capabilities: ['metadata', 'cover'] },
  };
}
function candidate(kind: BookEnrichmentCandidate['kind'] = 'metadata'): BookEnrichmentCandidate {
  const base = {
    schemaVersion: 1 as const,
    id: `${kind}-1`,
    bookId: 'novel-1',
    status: 'pending' as const,
    baseMetadataRevision: 1,
    provenance,
    createdAt: provenance.generatedAt,
    updatedAt: provenance.generatedAt,
  };
  return kind === 'metadata'
    ? {
        ...base,
        kind,
        baseValues: { title: '테스트 소설', author: '이전 작가' },
        patch: { title: '추천 제목', author: '추천 작가', tags: ['추천 태그'] },
      }
    : {
        ...base,
        kind,
        baseCover: { present: false },
        derivationFingerprint: 'cover-fixture',
        cover: {
          blob: new Blob(['fixture'], { type: 'image/png' }),
          fileName: 'cover.png',
          contentType: 'image/png',
          contentHash: 'fixture-cover',
          pixelWidth: 100,
          pixelHeight: 150,
          fit: 'contain',
          positionX: 32,
          positionY: 68,
        },
      };
}
function receipt(): BookEnrichmentApprovalReceipt {
  return {
    schemaVersion: 2,
    id: 'receipt-1',
    action: 'apply',
    candidateId: 'metadata-1',
    bookId: 'novel-1',
    kind: 'metadata',
    baseMetadataRevision: 1,
    appliedMetadataRevision: 2,
    selectedFields: ['title'],
    beforeHash: 'before',
    afterHash: 'after',
    before: { kind: 'metadata', values: { title: '이전 제목' } },
    after: { kind: 'metadata', values: { title: '테스트 소설' } },
    provenance,
    appliedAt: '2026-07-02T00:00:00.000Z',
  };
}
function controller(overrides: Partial<BookEnrichmentController> = {}): BookEnrichmentController {
  return {
    available: true,
    providers: [provider()],
    candidates: [],
    receipts: [],
    busy: false,
    load: vi.fn().mockResolvedValue(undefined),
    propose: vi.fn().mockResolvedValue(undefined),
    applyMetadata: vi.fn().mockResolvedValue(true),
    applyCover: vi.fn().mockResolvedValue(true),
    reject: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover-fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
});
function text(node: ReactTestInstance): string {
  if (String(node.props['aria-hidden']) === 'true') return '';
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, name: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node).trim()) === name);
}
async function click(node: ReactTestInstance) {
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onClick();
  });
}
function mount(value = controller(), overrides: Partial<Props> = {}) {
  const props: Props = {
    book: novel(),
    controller: value,
    dirty: false,
    saveDraft: vi.fn().mockResolvedValue(undefined),
    onApplied: vi.fn(),
    cover: <span>기존 표지</span>,
    ...overrides,
  };
  act(() => {
    renderer = create(<UiNextEnrichment {...props} />);
  });
  return { root: renderer!.root, props };
}
function check(root: ReactTestInstance, label: string) {
  return root
    .findAllByType('label')
    .find((node) => node.findAllByType('small').some((small) => text(small) === label))!
    .findByType('input');
}
function toggle(root: ReactTestInstance, label: string) {
  act(() => check(root, label).props.onChange());
}

describe('UiNextEnrichment provider selection', () => {
  it('renders nothing when enrichment is unavailable', () => {
    mount(controller({ available: false }));
    expect(renderer!.toJSON()).toBeNull();
  });
  it('explains where to enable providers without offering search', () => {
    const { root } = mount(controller({ providers: [] }));
    expect(text(root)).toContain('설정 › 기능 확장');
    expect(root.findAllByType('button')).toHaveLength(0);
  });
  it('loads the book and proposes using the only provider without a selector', async () => {
    const value = controller();
    const { root } = mount(value);
    expect(value.load).toHaveBeenCalledExactlyOnceWith('novel-1');
    expect(root.findAllByType('select')).toHaveLength(0);
    await click(button(root, '작품 정보 찾기'));
    expect(value.propose).toHaveBeenCalledExactlyOnceWith('novel-1', provenance.contributionId);
  });
  it('disables search while busy', () => {
    const { root, props } = mount(controller({ busy: true }));
    expect(button(root, '찾는 중…').props.disabled).toBe(true);
    expect(props.controller.propose).not.toHaveBeenCalled();
  });
  it('proposes using the selected provider when several are available', async () => {
    const { root, props } = mount(controller({ providers: [provider(), provider('trusted.other.books')] }));
    const select = root.findByProps({ 'aria-label': '작품 정보를 찾을 곳' });
    act(() => select.props.onChange({ target: { value: 'trusted.other.books' } }));
    await click(button(root, '작품 정보 찾기'));
    expect(props.controller.propose).toHaveBeenCalledExactlyOnceWith('novel-1', 'trusted.other.books');
  });
});

describe('UiNextEnrichment candidates', () => {
  it('toggles individual fields, restores all, and applies only the selected fields', async () => {
    const { root, props } = mount(controller({ candidates: [candidate()] }));
    expect(button(root, '모두 적용').props.disabled).toBe(false);
    toggle(root, '작가');
    expect(check(root, '작가').props.checked).toBe(false);
    expect(button(root, '2개 적용')).toBeDefined();
    toggle(root, '작가');
    expect(button(root, '모두 적용')).toBeDefined();
    toggle(root, '작가');
    toggle(root, '태그');
    await click(button(root, '1개 적용'));
    expect(props.controller.applyMetadata).toHaveBeenCalledExactlyOnceWith('metadata-1', ['title']);
    expect(props.onApplied).toHaveBeenCalledExactlyOnceWith();
  });
  it('disables applying when no field is selected', () => {
    const { root, props } = mount(controller({ candidates: [candidate()] }));
    for (const field of ['제목', '작가', '태그']) toggle(root, field);
    expect(button(root, '0개 적용').props.disabled).toBe(true);
    expect(props.controller.applyMetadata).not.toHaveBeenCalled();
  });
  it.each([false, true])('notifies after applying all metadata only if committed (%s)', async (applied) => {
    const { root, props } = mount(
      controller({ candidates: [candidate()], applyMetadata: vi.fn().mockResolvedValue(applied) }),
    );
    await click(button(root, '모두 적용'));
    expect(props.controller.applyMetadata).toHaveBeenCalledExactlyOnceWith('metadata-1', ['title', 'author', 'tags']);
    expect(props.onApplied).toHaveBeenCalledTimes(applied ? 1 : 0);
  });
  it.each(['metadata', 'cover'] as const)('rejects a %s candidate', async (kind) => {
    const { root, props } = mount(controller({ candidates: [candidate(kind)] }));
    await click(button(root, '건너뛰기'));
    expect(props.controller.reject).toHaveBeenCalledExactlyOnceWith(`${kind}-1`);
    expect(props.onApplied).not.toHaveBeenCalled();
  });
  it.each(['metadata', 'cover'] as const)('blocks applying %s while dirty and offers saving', async (kind) => {
    const { root, props } = mount(controller({ candidates: [candidate(kind)] }), { dirty: true });
    expect(button(root, kind === 'metadata' ? '모두 적용' : '표지 적용').props.disabled).toBe(true);
    expect(text(root)).toContain('먼저 저장해야');
    await click(button(root, '지금 저장'));
    expect(props.saveDraft).toHaveBeenCalledExactlyOnceWith();
    expect(props.controller.applyMetadata).not.toHaveBeenCalled();
    expect(props.controller.applyCover).not.toHaveBeenCalled();
  });
  it('applies the recommended cover with its exact layout', async () => {
    const { root, props } = mount(controller({ candidates: [candidate('cover')] }));
    expect(root.findByProps({ alt: '추천 표지' }).props.src).toBe('blob:cover-fixture');
    await click(button(root, '표지 적용'));
    expect(props.controller.applyCover).toHaveBeenCalledExactlyOnceWith('cover-1', {
      fit: 'contain',
      positionX: 32,
      positionY: 68,
    });
    expect(props.onApplied).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['metadata', 'cover'] as const)('disables a stale %s candidate', (kind) => {
    const { root } = mount(controller({ candidates: [{ ...candidate(kind), status: 'stale' }] }));
    expect(button(root, kind === 'metadata' ? '모두 적용' : '표지 적용').props.disabled).toBe(true);
    expect(text(root)).toContain('작품 정보가 바뀌어서 다시 찾아야');
  });
});

describe('UiNextEnrichment receipts', () => {
  it('waits for undo before notifying the editor', async () => {
    let resolveUndo!: (value: boolean) => void;
    const undone = new Promise<boolean>((resolve) => {
      resolveUndo = resolve;
    });
    const { root, props } = mount(controller({ receipts: [receipt()], undo: vi.fn(() => undone) }));
    await click(button(root, '되돌리기'));
    expect(props.controller.undo).toHaveBeenCalledExactlyOnceWith('receipt-1');
    expect(props.onApplied).not.toHaveBeenCalled();
    await act(async () => {
      resolveUndo(true);
      await undone;
    });
    expect(props.onApplied).toHaveBeenCalledExactlyOnceWith();
  });
  it('does not notify when undo was not committed', async () => {
    const { root, props } = mount(controller({ receipts: [receipt()], undo: vi.fn().mockResolvedValue(false) }));
    await click(button(root, '되돌리기'));
    expect(props.onApplied).not.toHaveBeenCalled();
  });
});
