import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { actions, model, novel } from './test-fixtures';
import { UiNextWorkspace, WorkspaceLibraryScreen } from './Workspace';
import { UiNextShell } from './shell/UiNextShell';
import { UiNextLibraryScreen } from './library/UiNextLibraryScreen';
import { createUiNextNavigation } from './shell/navigation';

afterEach(() => {
  vi.unstubAllGlobals();
});
const props = () => ({ model: model([novel()]), actions: actions() });
describe('workspace routing', () => {
  it('renders the accessible library and never mounts legacy chrome when enabled', () => {
    const p = props();
    const markup = renderToStaticMarkup(
      <UiNextWorkspace {...p} view="library">
        <WorkspaceLibraryScreen {...p} />
      </UiNextWorkspace>,
    );
    expect(markup).toContain('aria-label="주 메뉴"');
    expect(markup).toContain('aria-label="서재 검색"');
    expect(markup).toContain(`aria-label="${p.model.collection.visibleBooks[0].novel.title} 열기"`);
    for (const legacy of [
      'library-sidebar',
      'library-topbar',
      'library-mobile-header',
      'library-navigation-button',
      'library-inspector',
    ])
      expect(markup).not.toContain(legacy);
  });
  it.each(['reader', 'document'])('omits shell chrome for %s and preserves children', (view) => {
    const markup = renderToStaticMarkup(
      <UiNextWorkspace {...props()} view={view}>
        <main>본문</main>
      </UiNextWorkspace>,
    );
    expect(markup).toBe('<main>본문</main>');
  });
  it.each(['library', 'chapters'])('keeps existing non-library content inside the shell in %s', (view) => {
    const markup = renderToStaticMarkup(
      <UiNextWorkspace {...props()} view={view}>
        <main>기존 화면</main>
      </UiNextWorkspace>,
    );
    expect(markup).toContain('aria-label="주 메뉴"');
    expect(markup).toContain('<main>기존 화면</main>');
    expect(markup).toContain('aria-label="탭"');
  });
  it('delivers search requests across route mounts and increments repeated requests', () => {
    // The real shell now installs browser effects; keep this Node renderer test self-contained.
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({})),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const p = props();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <UiNextWorkspace {...p} view="library">
          <main>탐색</main>
        </UiNextWorkspace>,
      );
    });
    act(() => {
      renderer.root.findByType(UiNextShell).props.focusSearch();
    });
    act(() => {
      renderer.update(
        <UiNextWorkspace {...p} view="library">
          <WorkspaceLibraryScreen {...p} />
        </UiNextWorkspace>,
      );
    });
    expect(renderer.root.findByType(UiNextLibraryScreen).props.navigation.searchFocusRequest).toBe(1);
    act(() => {
      renderer.root.findByType(UiNextShell).props.focusSearch();
    });
    expect(renderer.root.findByType(UiNextLibraryScreen).props.navigation.searchFocusRequest).toBe(2);
    expect(p.actions.presentation.goHome).toHaveBeenCalledTimes(2);
    expect(p.actions.controls.setShelf).toHaveBeenCalledWith(undefined);
    act(() => renderer.unmount());
  });
});
describe('shell navigation contract', () => {
  it('routes tabs and search through existing actions', () => {
    const p = props();
    p.actions.header.openDiscovery = vi.fn();
    const focus = vi.fn();
    const navigation = createUiNextNavigation(p, 'library', 4, focus);
    navigation.openDiscovery?.();
    navigation.openSettings();
    navigation.openLibraryRoot();
    navigation.focusSearch();
    expect(p.actions.header.openDiscovery).toHaveBeenCalledOnce();
    expect(p.actions.header.openSettings).toHaveBeenCalledOnce();
    expect(p.actions.presentation.goHome).toHaveBeenCalledTimes(2);
    expect(p.actions.controls.setShelf).toHaveBeenCalledWith(undefined);
    expect(focus).toHaveBeenCalledOnce();
    expect(navigation.searchFocusRequest).toBe(4);
  });
  it('maps discovery, source, chapters and reader states', () => {
    const p = props();
    p.model.discovery = { active: true, scope: 'test' };
    expect(createUiNextNavigation(p, 'library', 0, vi.fn()).activeTab).toBe('discovery');
    p.model.discovery.active = false;
    p.model.externalSources.active = true;
    expect(createUiNextNavigation(p, 'library', 0, vi.fn()).activeTab).toBe('discovery');
    expect(createUiNextNavigation(p, 'chapters', 0, vi.fn()).activeTab).toBe('library');
    expect(createUiNextNavigation(p, 'reader', 0, vi.fn()).isReader).toBe(true);
    expect(createUiNextNavigation(p, 'document', 0, vi.fn()).isReader).toBe(true);
  });
});
