import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { ReaderRuntime } from '../../src/repositories/reader-runtime';
import { PlatformPluginProvider, useProductPlugins } from '../../src/extensions/platform/PlatformPluginProvider';
import { PluginsSection } from '../../src/ui-next/settings/pages/PluginsSection';
import { usePluginHome } from '../../src/ui-next/home/usePluginHome';
import { appendPluginHomeRows } from '../../src/ui-next/home/config';
import { DiscoveryCard, HomeRow } from '../../src/ui-next/home/rows';
import { useSearchRoute } from '../../src/ui-next/search/route';
import '../../src/ui-next/styles/tokens.css';
import '../../src/ui-next/styles/kit.css';
import '../../src/ui-next/home/home.css';
import '../../src/ui-next/library/library.css';
import '../../src/ui-next/settings/extensions.css';
import '../../src/ui-next/components/prefs.css';
import '../../src/ui-next/settings/settings.css';
import '../../src/ui-next/settings/pages/pages.css';

const runtime = { mode: 'remote', apiBaseUrl: '/api' } as ReaderRuntime;
function Fixture() {
  const [settings, setSettings] = useState(true);
  const plugins = useProductPlugins();
  const home = usePluginHome();
  const search = useSearchRoute();
  const rows = home ? appendPluginHomeRows([], home.sections).map((config) => home.row(config)) : [];
  return (
    <main style={{ maxWidth: 1100, margin: 'auto', paddingBlock: 24 }}>
      <nav style={{ display: 'flex', gap: 8, paddingInline: 'var(--un-pad)' }}>
        <button className="un-btn is-ghost" onClick={() => setSettings(true)}>
          플러그인 설정
        </button>
        <button className="un-btn is-ghost" onClick={() => setSettings(false)}>
          홈 보기
        </button>
      </nav>
      <p data-testid="runtime-state" style={{ paddingInline: 'var(--un-pad)', color: 'var(--un-text-3)' }}>
        {plugins.session ? '준비됨' : plugins.message}
      </p>
      {settings ? (
        <div className="un-settings-content">
          <div className="un-settings-panel">
            <PluginsSection />
          </div>
        </div>
      ) : (
        <div className="un-home-rows">
          {rows.map((row) => (
            <HomeRow key={row.config.id} row={row}>
              {row.items.map(
                (item) =>
                  item.kind === 'discovery' && (
                    <DiscoveryCard key={item.key} work={item.work} ranked rank={item.work.rank} />
                  ),
              )}
            </HomeRow>
          ))}
          {!rows.length && <p style={{ paddingInline: 'var(--un-pad)' }}>설치된 홈 플러그인이 없습니다.</p>}
        </div>
      )}
      {search && (
        <label style={{ display: 'flex', gap: 8, paddingInline: 'var(--un-pad)' }}>
          검색어
          <input aria-label="검색어" readOnly value={search.initialQuery ?? ''} />
        </label>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <PlatformPluginProvider runtime={runtime}>
    <Fixture />
  </PlatformPluginProvider>,
);
