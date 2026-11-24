import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { actions, model, novel } from '../test-fixtures';
import { createUiNextLibraryAdapter } from '../library/model';
import { UiNextSearchScreen } from './UiNextSearchScreen';
import type { UiNextSearchAdapter } from './contract';

it('returns focus to the selected later match and restores the typed query, page, and scroll positions', () => {
  vi.stubGlobal('window', new EventTarget());
  const documentState = { activeElement: null as Card | null, documentElement: { style: {} } };
  vi.stubGlobal('document', documentState);
  class Card {
    constructor(
      readonly dataset: { navigationItem: string },
      readonly rail: string,
    ) {}
    closest(selector: string) {
      return selector === '[data-navigation-rail]' ? { dataset: { navigationRail: this.rail } } : this;
    }
    focus = vi.fn(() => {
      documentState.activeElement = this;
    });
    scrollIntoView = vi.fn();
  }
  vi.stubGlobal('Element', Card);
  let chosenCard: Card | undefined;
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const props = {
    model: model(Array.from({ length: 45 }, (_, i) => novel({ id: String(i), title: `작품 ${i + 1}` }))),
    actions: actions(),
  };
  const library = createUiNextLibraryAdapter(props);
  const adapter: UiNextSearchAdapter = {
    library: (query) => library.works.filter((item) => item.kind === 'book' && item.book.novel.title.includes(query)),
    libraryHelpers: library,
    submitted: '',
    sources: [],
    recent: [],
    submit: vi.fn(),
    cancel: vi.fn(),
    clearRecent: vi.fn(),
    removeRecent: vi.fn(),
  };
  const nodes = new Map<string, EventTarget & { scrollTop: number; scrollLeft: number }>();
  const mount = () =>
    create(<UiNextSearchScreen routeId="fixture-search" adapter={adapter} close={vi.fn()} />, {
      createNodeMock: (element) => {
        const cls = element.props.className;
        if (cls !== 'un-search-body' && cls !== 'un-row-track') return null;
        const node = Object.assign(new EventTarget(), {
          scrollTop: 0,
          scrollLeft: 0,
          scrollWidth: 900,
          clientWidth: 400,
          scrollTo() {},
          querySelectorAll: () => (chosenCard ? [chosenCard] : []),
        });
        nodes.set(cls, node);
        return node;
      },
    });
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = mount();
    });
    const input = () => renderer.root.findByProps({ 'aria-label': '검색어' });
    const buttons = () => renderer.root.findAllByType('button').filter((b) => b.props['aria-label']?.endsWith(' 열기'));
    act(() => input().props.onChange({ target: { value: '작품' } }));
    expect(buttons()).toHaveLength(30);
    act(() => renderer.root.findByProps({ 'aria-label': '다음 페이지' }).props.onClick());
    expect(buttons()).toHaveLength(15);
    const chosen = buttons()[12].props['aria-label'];
    const body = nodes.get('un-search-body')!;
    const track = nodes.get('un-row-track')!;
    body.scrollTop = 120;
    track.scrollLeft = 650;
    body.dispatchEvent(new Event('scroll'));
    track.dispatchEvent(new Event('scroll'));
    const key = buttons()[12].props['data-navigation-item'];
    const rail = renderer.root.findByProps({ className: 'un-row-track' }).props['data-navigation-rail'];
    chosenCard = new Card({ navigationItem: key }, rail);
    const click = new Event('click');
    Object.defineProperty(click, 'target', { value: chosenCard });
    body.dispatchEvent(click);
    act(() => buttons()[12].props.onClick());
    expect(props.actions.books.open).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
    act(() => {
      renderer = mount();
    });
    expect(chosenCard.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(documentState.activeElement).toBe(chosenCard);
    expect(input().props.value).toBe('작품');
    expect(buttons().map((b) => b.props['aria-label'])).toContain(chosen);
    expect(nodes.get('un-search-body')!.scrollTop).toBe(120);
    expect(nodes.get('un-row-track')!.scrollLeft).toBe(650);
    expect(adapter.submit).not.toHaveBeenCalled();
    act(() => input().props.onChange({ target: { value: '작품 1' } }));
    expect(buttons().length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ 'aria-label': '다음 페이지' })).toHaveLength(0);
  } finally {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it('shows retained source cards during revalidation and a retry when the connection fails', () => {
  const helpers = createUiNextLibraryAdapter({ model: model([]), actions: actions() });
  for (const status of ['loading', 'failed'] as const) {
    const adapter: UiNextSearchAdapter = {
      library: () => [],
      libraryHelpers: helpers,
      submitted: 'query',
      recent: [],
      submit: vi.fn(),
      cancel: vi.fn(),
      clearRecent: vi.fn(),
      removeRecent: vi.fn(),
      sources: [
        {
          sourceId: 'fixture',
          title: '검색 소스',
          status,
          retry: vi.fn(),
          items: [{ id: 'card', title: '기존 검색 결과', open: vi.fn() }],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <UiNextSearchScreen routeId="retained-source" adapter={adapter} initialQuery="query" close={vi.fn()} />,
    );
    expect(html).toContain('기존 검색 결과');
    expect(html).toContain(status === 'failed' ? '다시 시도' : '찾는 중');
  }
});
