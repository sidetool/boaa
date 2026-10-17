import { createRoot } from 'react-dom/client';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { ServerManagementClient } from '../../features/server-management/server-management-client';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import '../../ui-next/styles/tokens.css';
import '../../ui-next/styles/kit.css';
import '../../ui-next/settings/settings.css';
import '../../ui-next/settings/extensions.css';
import '../../ui-next/settings/pages/pages.css';
import { ServerPage } from '../../ui-next/settings/pages/ServerPage';
import { SourceNetworkSettings } from '../../ui-next/settings/SourceNetworkSettings';

/**
 * Browser smoke harness (scripts/server-management-ui-smoke.mjs): the real pages and HTTP client against a
 * mocked /api, outside the full app shell.
 */
const api = new RemoteApiClient('/api');
const manager = {
  target: 'server',
  networkSettings: (request?: unknown, signal?: AbortSignal) =>
    api.request('/source-network-settings', {
      method: request ? 'PUT' : 'GET',
      ...(request ? { body: JSON.stringify(request) } : {}),
      signal,
    }),
  getSnapshot: () => ({ error: undefined }),
  subscribe: () => () => undefined,
} as unknown as InstalledExtensionManager;

const pages = (
  <>
    <div className="reader-settings-panel un-settings-panel" data-testid="server">
      <ServerPage client={new ServerManagementClient(api)} />
    </div>
    <section className="un-ext" data-testid="network" style={{ marginTop: 24 }}>
      <details className="un-ext-advanced" open>
        <summary>고급</summary>
        <SourceNetworkSettings manager={manager} />
      </details>
    </section>
  </>
);

/**
 * `?shell` mounts the pages inside the real settings overlay DOM (fixed, nav + content grid) to check tablet and
 * desktop layouts; the default flows in the document so full-page screenshots capture everything.
 */
const shell = new URLSearchParams(window.location.search).has('shell');

createRoot(document.getElementById('root')!).render(
  shell ? (
    <div className="ui-next un-settings reader-settings-dialog is-detail" role="dialog" aria-label="설정">
      <div className="un-settings-body">
        <nav className="un-settings-nav" aria-label="설정 분류" />
        <main className="un-settings-main">
          <div className="un-settings-content reader-settings-content">
            <h2 className="un-settings-title">서버 관리</h2>
            {pages}
          </div>
        </main>
      </div>
    </div>
  ) : (
    <div className="ui-next" style={{ minHeight: '100vh', background: 'var(--un-bg)' }}>
      <div className="un-settings-content reader-settings-content">{pages}</div>
    </div>
  ),
);
