import type { ReaderAddonIconName } from '@boaa/extension-contracts';
import { BarChart3, FileText, Headphones, List, StickyNote, Wand2, X, type LucideIcon } from 'lucide-react';
import { useId, useRef } from 'react';
import type { ReaderAddonShellProps } from '../../features/reader/reader-addon-contract';
import { useDismissibleLayer, useMediaQuery } from '../../shared/ui/use-dismissible-layer';
import { cx } from '../components/primitives';
import '../styles/tokens.css';
import '../styles/kit.css';
import './tools.css';

const icons: Record<ReaderAddonIconName, LucideIcon> = {
  chart: BarChart3,
  'file-text': FileText,
  headphones: Headphones,
  list: List,
  notes: StickyNote,
  wand: Wand2,
};

/** Reader tools: a side panel beside the page on wide screens, a bottom sheet over it on phones. */
export function UiNextReaderTools({ activeTab, tabs, children, setActiveTab, close }: ReaderAddonShellProps) {
  const panelRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const sheet = useMediaQuery('(max-width: 699px)');
  useDismissibleLayer({
    open: true,
    modal: sheet,
    containerRef: panelRef,
    layerRootRef: layerRef,
    initialFocusRef: closeRef,
    onClose: close,
  });
  const current = tabs.find((tab) => tab.id === activeTab);

  return (
    <div
      ref={layerRef}
      className={cx('ui-next un-tools-layer', sheet && 'is-sheet')}
      onClick={(event) => sheet && event.target === event.currentTarget && close()}
    >
      {/* `addon-panel` stays so plugin panels can find the close button. */}
      <aside
        ref={panelRef}
        className="addon-panel un-kit un-tools"
        role="dialog"
        aria-modal={sheet || undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <span className="un-sheet-grabber" aria-hidden="true" />
        <header className="un-tools-head">
          <h2 id={titleId}>{current?.label ?? '읽기 도구'}</h2>
          <button
            data-reader-addon-close
            ref={closeRef}
            className="un-icon-btn"
            type="button"
            onClick={close}
            aria-label="읽기 도구 닫기"
          >
            <X size={20} />
          </button>
        </header>
        <nav className="un-tools-tabs" role="tablist" aria-label="읽기 도구 분류">
          {tabs.map((tab) => {
            const Icon = icons[tab.icon];
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className={cx(active && 'is-active')}
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="addon-panel-content un-tools-body" role="tabpanel" aria-labelledby={titleId}>
          {children}
        </div>
      </aside>
    </div>
  );
}
