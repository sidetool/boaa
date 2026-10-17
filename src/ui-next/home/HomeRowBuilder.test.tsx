import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceFilterDefinition } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../../features/external-sources/external-source-controller-contract';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import { useDiscoveryPages } from '../../features/discovery/useDiscoveryPages';
import type { HomeSourceRowSection } from './contract';
import { HomeRowBuilder, type HomeRowBuilderProps } from './HomeRowBuilder';
import { normalizeSourceRowSection } from './source-row';

// Keep the real source-view hook and filter controls; only list I/O is replaced.
vi.mock('../../features/discovery/useDiscoveryPages', () => ({ useDiscoveryPages: vi.fn() }));
const definitions: ExternalSourceFilterDefinition[] = [
  { id: 'genre', kind: 'select', label: '장르', position: 0, options: ['전체', '판타지'], defaultValue: 0 },
  { id: 'day', kind: 'select', label: '요일', position: 1, options: ['전체', '월요일'], defaultValue: 0 },
];
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useDiscoveryPages).mockReturnValue({
    items: [],
    browse: { activeMode: 'popular', availableModes: ['popular', 'latest', 'search'], filters: definitions },
    busy: false,
    error: '',
    hasPage: true,
    more: false,
    retry: vi.fn(),
    loadMore: vi.fn(),
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'button' && text(node) === label);
}
function click(node: ReactTestInstance) {
  act(() => node.props.onClick());
}
function mount(initial?: HomeSourceRowSection) {
  const sourceView: ExternalSourceView = {
    id: 'fixture.catalog',
    title: '테스트 소스',
    kind: 'catalog',
    origin: 'plugin',
    connection: { state: 'connected' },
  };
  const props: HomeRowBuilderProps = {
    source: { id: sourceView.id, title: sourceView.title },
    sourceView,
    session: { key: (id, input) => JSON.stringify([id, input]) } as DiscoverySession,
    initial,
    onSave: vi.fn(),
    onBack: vi.fn(),
  };
  act(() => {
    renderer = create(<HomeRowBuilder {...props} />);
  });
  return { root: renderer!.root, props };
}
function nameInput(root: ReactTestInstance) {
  return root.findByType('input');
}
function filterFold(root: ReactTestInstance) {
  return root.find((node) => node.type === 'button' && node.props.className === 'un-row-builder-fold');
}

describe('HomeRowBuilder', () => {
  it('switches popular/latest through the real view hook and updates the automatic title', () => {
    const { root } = mount();
    expect(button(root, '인기').props['aria-checked']).toBe(true);
    expect(nameInput(root).props.value).toBe('테스트 소스 · 인기');
    click(button(root, '최신'));
    expect(button(root, '최신').props['aria-checked']).toBe(true);
    expect(button(root, '인기').props['aria-checked']).toBe(false);
    expect(useDiscoveryPages).toHaveBeenLastCalledWith(
      expect.anything(),
      'fixture.catalog',
      { parentRef: undefined, browseMode: 'latest' },
      0,
      true,
      undefined,
      expect.any(String),
    );
    expect(nameInput(root).props.value).toBe('테스트 소스 · 최신');
    click(button(root, '인기'));
    expect(nameInput(root).props.value).toBe('테스트 소스 · 인기');
  });

  it('expands and folds filters without discarding a chosen value', () => {
    const { root } = mount();
    expect(filterFold(root).props['aria-expanded']).toBe(false);
    expect(root.findAllByType('fieldset')).toHaveLength(0);
    click(filterFold(root));
    expect(filterFold(root).props['aria-expanded']).toBe(true);
    click(button(root, '판타지'));
    click(filterFold(root));
    expect(root.findAllByType('fieldset')).toHaveLength(0);
    click(filterFold(root));
    expect(button(root, '판타지').props['aria-pressed']).toBe(true);
  });

  it('saves pending filters before preview apply, with a normalized signature and automatic summary', () => {
    const { root, props } = mount();
    click(button(root, '최신'));
    click(filterFold(root));
    click(button(root, '판타지'));
    click(button(root, '월요일'));
    expect(useDiscoveryPages).toHaveBeenLastCalledWith(
      expect.anything(),
      'fixture.catalog',
      { parentRef: undefined, browseMode: 'latest' },
      0,
      true,
      undefined,
      expect.any(String),
    );
    expect(nameInput(root).props.value).toBe('테스트 소스 · 최신 · 판타지 · 월요일');
    click(button(root, '홈에 추가'));
    const expected = normalizeSourceRowSection(
      {
        sourceId: 'fixture.catalog',
        mode: 'latest',
        filters: [
          { position: 0, value: 1 },
          { position: 1, value: 1 },
        ],
        title: '테스트 소스 · 최신 · 판타지 · 월요일',
        summary: '최신 · 판타지 · 월요일',
      },
      definitions,
    );
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(expected);
    expect(expected?.filterSignature).toBe(JSON.stringify(definitions));
    expect(expected?.filters).toEqual([
      { position: 0, value: 1 },
      { position: 1, value: 1 },
    ]);
  });

  it('applies filters to the preview and can return to the unfiltered list', () => {
    const { root, props } = mount();
    click(filterFold(root));
    click(button(root, '판타지'));
    click(button(root, '적용해서 미리보기'));
    expect(useDiscoveryPages).toHaveBeenLastCalledWith(
      expect.anything(),
      'fixture.catalog',
      expect.objectContaining({
        browseMode: 'search',
        filters: [
          { position: 0, groupPosition: undefined, value: 1 },
          { position: 1, groupPosition: undefined, value: 0 },
        ],
      }),
      0,
      true,
      undefined,
      expect.any(String),
    );
    click(button(root, '필터 없이'));
    expect(nameInput(root).props.value).toBe('테스트 소스 · 인기');
    click(button(root, '홈에 추가'));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: 'popular' }));
    expect(vi.mocked(props.onSave).mock.calls[0][0].filters).toBeUndefined();
  });

  it('preserves a custom name across mode changes and returns to the automatic name after clearing on blur', () => {
    const { root, props } = mount();
    act(() => nameInput(root).props.onChange({ target: { value: '  내 추천  ' } }));
    click(button(root, '최신'));
    expect(nameInput(root).props.value).toBe('  내 추천  ');
    click(button(root, '홈에 추가'));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ title: '내 추천', mode: 'latest' }));
    act(() => nameInput(root).props.onChange({ target: { value: '   ' } }));
    act(() => nameInput(root).props.onBlur());
    expect(nameInput(root).props.value).toBe('테스트 소스 · 최신');
  });

  it('edits initial settings, opens their filters, saves a normalized section and goes back to editing', () => {
    const initial: HomeSourceRowSection = {
      sourceId: 'fixture.catalog',
      mode: 'latest',
      title: '기존 줄',
      parentRef: 'fixture-folder',
      filters: [{ position: 0, value: 1 }],
    };
    const { root, props } = mount(initial);
    expect(nameInput(root).props.value).toBe('기존 줄');
    expect(filterFold(root).props['aria-expanded']).toBe(true);
    expect(button(root, '판타지').props['aria-pressed']).toBe(true);
    expect(root.findAllByType('button').map(text)).not.toContain('홈에 추가');
    click(button(root, '저장'));
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith(
      normalizeSourceRowSection({ ...initial, summary: '최신 · 판타지' }, definitions),
    );
    click(button(root, '편집으로'));
    expect(props.onBack).toHaveBeenCalledExactlyOnceWith();
  });

  it('returns a new row to the add choices', () => {
    const { root, props } = mount();
    click(button(root, '줄 추가로'));
    expect(props.onBack).toHaveBeenCalledExactlyOnceWith();
    expect(props.onSave).not.toHaveBeenCalled();
  });
});
