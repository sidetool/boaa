import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoverySession } from '../../features/discovery/discovery-session';
import type { ExternalSourceView } from '../../features/external-sources/external-source-controller-contract';
import type { HomeRowConfig, HomeSourceRowSection, UiNextHomeAdapter } from './contract';
import { HomeEditor } from './HomeEditor';
import { HomeRowBuilder } from './HomeRowBuilder';

// Builder behavior has its own tests; exercise the editor's source/build/save contract here.
vi.mock('./HomeRowBuilder', () => ({ HomeRowBuilder: vi.fn(() => null) }));
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}
function button(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'button' && (node.props['aria-label'] ?? text(node)) === label);
}
function click(node: ReactTestInstance) {
  act(() => node.props.onClick());
}
const section: HomeSourceRowSection = {
  sourceId: 'fixture.catalog',
  mode: 'popular',
  title: '내 추천 줄',
  summary: '인기 · 판타지',
  filters: [{ position: 0, value: 1 }],
};
function mount(config: HomeRowConfig[] = [{ id: 'recent', kind: 'recently-added', visible: true }]) {
  const sourceView: ExternalSourceView = {
    id: 'fixture.catalog',
    title: '테스트 소스',
    kind: 'catalog',
    origin: 'plugin',
    connection: { state: 'connected' },
  };
  const adapter: UiNextHomeAdapter = {
    status: 'ready',
    hero: [],
    rows: [],
    config,
    rowOptions: [
      { kind: 'favorites', label: '즐겨찾기', hint: '좋아하는 작품' },
      { kind: 'shelf', shelfId: 'shelf-1', label: '내 책장', hint: '책장에 담은 작품' },
      { kind: 'discovery', discoveryTabId: 'tab-1', label: '탐색 추천', hint: '탐색 목록' },
    ],
    rowLabel: (row) => row.section?.title ?? row.id,
    setConfig: vi.fn(),
    resetConfig: vi.fn(),
    importFiles: vi.fn(),
    library: {} as UiNextHomeAdapter['library'],
    rowBuilder: {
      sources: [{ id: sourceView.id, title: sourceView.title }],
      session: {} as DiscoverySession,
      sourceView: vi.fn(() => sourceView),
    },
  };
  act(() => {
    renderer = create(<HomeEditor adapter={adapter} />);
  });
  return { root: renderer!.root, adapter, config, sourceView };
}
function chooseSource(root: ReactTestInstance) {
  click(button(root, '줄 추가'));
  click(root.find((node) => node.type === 'button' && node.props.className === 'un-home-editor-pick'));
  return root.findByType(HomeRowBuilder);
}

describe('HomeEditor source rows', () => {
  it('groups add choices into source builder, library, shelves and discovery tabs', () => {
    const { root } = mount();
    click(button(root, '줄 추가'));
    expect(root.findAllByType('h4').map(text)).toEqual(['소스에서 새 줄 만들기', '내 서재', '책장', '탐색 탭에서']);
    expect(text(root)).toContain('테스트 소스');
    const groups = root.findAllByType('section');
    expect(groups.map((group) => group.findByType('h4')).map(text)).toEqual(['내 서재', '책장', '탐색 탭에서']);
    expect(groups.map((group) => group.findAllByType('li').map(text))).toEqual([
      ['즐겨찾기좋아하는 작품넣기'],
      ['내 책장책장에 담은 작품넣기'],
      ['탐색 추천탐색 목록넣기'],
    ]);
    click(button(root, '편집으로'));
    expect(button(root, '줄 추가')).toBeDefined();
  });

  it('opens the chosen source builder and appends a visible source row with a unique id on save', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
    const { root, adapter, config, sourceView } = mount();
    const builder = chooseSource(root);
    expect(builder.props.source).toEqual({ id: 'fixture.catalog', title: '테스트 소스' });
    expect(builder.props.sourceView).toBe(sourceView);
    expect(builder.props.session).toBe(adapter.rowBuilder!.session);
    expect(builder.props.initial).toBeUndefined();
    act(() => builder.props.onSave(section));
    const first = vi.mocked(adapter.setConfig).mock.calls[0][0];
    expect(first).toEqual([
      ...config,
      { id: expect.stringMatching(/^source:fixture\.catalog:/), kind: 'source', visible: true, section },
    ]);
    expect(root.findAllByType(HomeRowBuilder)).toHaveLength(0);
    expect(button(root, '줄 추가')).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const secondBuilder = chooseSource(root);
    act(() => secondBuilder.props.onSave({ ...section, title: '두 번째 추천 줄' }));
    const second = vi.mocked(adapter.setConfig).mock.calls[1][0];
    expect(second).toHaveLength(3);
    expect(new Set(second.map((row) => row.id)).size).toBe(3);
    expect(second[1]).toEqual(first[1]);
    expect(second[2].section?.title).toBe('두 번째 추천 줄');
  });

  it('returns from a new builder to the add choices without changing config', () => {
    const { root, adapter } = mount();
    const builder = chooseSource(root);
    act(() => builder.props.onBack());
    expect(root.findAllByType('h4').map(text)).toContain('소스에서 새 줄 만들기');
    expect(adapter.setConfig).not.toHaveBeenCalled();
  });

  it('shows source summary and edits the existing row without changing its id, order or visibility', () => {
    const existing: HomeRowConfig = { id: 'saved-source', kind: 'source', visible: false, section };
    const { root, adapter, config } = mount([
      { id: 'recent', kind: 'recently-added', visible: true },
      existing,
      { id: 'favorite', kind: 'favorites', visible: true },
    ]);
    const listRow = root.find(
      (node) => node.type === 'li' && node.findAllByType('b').some((b) => text(b) === section.title),
    );
    expect(listRow.findByType('small').children).toEqual(['인기 · 판타지']);
    click(button(root, `${section.title} 줄 고치기`));
    const builder = root.findByType(HomeRowBuilder);
    expect(builder.props.initial).toBe(section);
    const edited = { ...section, mode: 'latest', title: '바꾼 추천 줄', summary: '최신 · 판타지' };
    act(() => builder.props.onSave(edited));
    expect(adapter.setConfig).toHaveBeenCalledExactlyOnceWith([config[0], { ...existing, section: edited }, config[2]]);
    expect(button(root, '바꾼 추천 줄 줄 고치기')).toBeDefined();
    expect(root.findByProps({ 'aria-label': '바꾼 추천 줄 표시' }).props['aria-checked']).toBe(false);
  });

  it('returns from editing without saving and removes only the chosen source row', () => {
    const { root, adapter, config } = mount([
      { id: 'recent', kind: 'recently-added', visible: true },
      { id: 'saved-source', kind: 'source', visible: true, section },
    ]);
    click(button(root, `${section.title} 줄 고치기`));
    act(() => root.findByType(HomeRowBuilder).props.onBack());
    expect(adapter.setConfig).not.toHaveBeenCalled();
    click(button(root, `${section.title} 줄 빼기`));
    expect(adapter.setConfig).toHaveBeenCalledExactlyOnceWith([config[0]]);
    expect(root.findAllByProps({ 'aria-label': `${section.title} 줄 고치기` })).toHaveLength(0);
  });
});
