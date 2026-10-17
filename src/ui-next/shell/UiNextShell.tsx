import { Compass, House, Library, Search, Settings } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cx } from '../components/primitives';
import type { UiNextShellProps } from './contract';
import '../styles/tokens.css';
import '../styles/kit.css';
import './shell.css';

const PRETENDARD =
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';

/** The UI font loads only for ui-next; the classic UI keeps its system stack. */
function usePretendard() {
  useEffect(() => {
    if (document.querySelector(`link[href="${PRETENDARD}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = PRETENDARD;
    document.head.append(link);
  }, []);
}

/** Classic screens scroll inside their own containers, so watch scrolling anywhere below the bar. */
function useScrolledBelowBar() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    // Sideways rails (continue row, ranked lists) fire scroll too, with a scrollTop of 0; they used to turn the
    // bar transparent over content. Only a change in vertical position counts.
    const lastTop = new WeakMap<EventTarget, number>();
    const onScroll = (event: Event) => {
      const target = event.target;
      const top =
        target instanceof HTMLElement ? target.scrollTop : (document.scrollingElement?.scrollTop ?? window.scrollY);
      const key = target ?? document;
      const before = lastTop.get(key) ?? 0;
      lastTop.set(key, top);
      if (before === top) return;
      setScrolled(top > 12);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  return scrolled;
}

interface Tab {
  id: 'home' | 'discovery' | 'library' | 'settings';
  label: string;
  icon: ReactNode;
  run?: () => void;
}

export function UiNextShell({
  children,
  isReader,
  readerOverlay,
  activeTab,
  openHome,
  openDiscovery,
  openLibraryRoot,
  openSettings,
  focusSearch: focusLibrarySearch,
  openSearch,
}: UiNextShellProps) {
  const focusSearch = openSearch ? () => openSearch() : focusLibrarySearch;
  usePretendard();
  const scrolled = useScrolledBelowBar();
  // Source streams own the viewport like the local reader; the bars return when the stream closes.
  if (isReader || readerOverlay) return <>{children}</>;

  const tabs: Tab[] = [
    { id: 'home', label: '홈', icon: <House size={22} />, run: openHome },
    { id: 'discovery', label: '탐색', icon: <Compass size={22} />, run: openDiscovery },
    { id: 'library', label: '서재', icon: <Library size={22} />, run: openLibraryRoot },
    { id: 'settings', label: '설정', icon: <Settings size={22} />, run: openSettings },
  ];
  const available = tabs.filter((tab) => tab.run);

  return (
    <div className="un-app">
      <header className={cx('un-topbar', scrolled && 'is-scrolled')}>
        <button type="button" className="un-logo" aria-label="BOAA 홈으로" onClick={openHome}>
          BOAA
          <i aria-hidden="true" />
        </button>
        <nav className="un-topnav" aria-label="주 메뉴">
          {available
            .filter((tab) => tab.id !== 'settings')
            .map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={cx(activeTab === tab.id && 'is-active')}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onClick={tab.run}
              >
                {tab.label}
              </button>
            ))}
        </nav>
        <div className="un-topbar-actions">
          {/* 통합 검색 covers every tab; without it the button falls back to the library's own field. */}
          {(openSearch || activeTab !== 'library') && (
            <button
              type="button"
              className="un-icon-btn"
              aria-label={openSearch ? '검색' : '서재 검색'}
              onClick={focusSearch}
            >
              <Search size={21} />
            </button>
          )}
          <button type="button" className="un-icon-btn un-wide-only" aria-label="설정" onClick={openSettings}>
            <Settings size={21} />
          </button>
        </div>
      </header>

      {children}

      <nav className="un-tabbar" aria-label="탭">
        {available.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={cx(activeTab === tab.id && 'is-active')}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={tab.run}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
