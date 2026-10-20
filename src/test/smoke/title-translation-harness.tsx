import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../../app/runtime/RuntimeProvider';
import type { AppRuntime } from '../../app/runtime/app-runtime';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import { DiscoveryCard, RowRail } from '../../ui-next/home/rows';
import { TranslationPage } from '../../ui-next/settings/pages/TranslationPage';
import { useTranslatedTitle } from '../../features/translation/use-translated-title';
import '../../styles/tokens.css';
import '../../styles/base.css';
import '../../ui-next/styles/tokens.css';
import '../../ui-next/styles/kit.css';
import '../../ui-next/styles/components.css';
import '../../ui-next/library/library.css';
import '../../ui-next/home/home.css';
import '../../ui-next/chapters/chapters.css';
import '../../ui-next/settings/settings.css';
const runtime = {
  platformRuntime: { kind: 'browser' },
  readerRuntime: { mode: 'remote', remoteApiClient: new RemoteApiClient('/api') },
} as unknown as AppRuntime;
const titles = ['A Journey Beyond the Stars', 'The Quiet Library', '한국어 작품'];
function Selected({ original }: { original: string }) {
  const title = useTranslatedTitle(original);
  return (
    <section aria-label="선택한 작품" className="un-detail-copy">
      <h1>{title}</h1>
      {title !== original && <p className="un-detail-byline">{original}</p>}
      <output aria-label="원래 작품 식별">{original}</output>
    </section>
  );
}
function Harness() {
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState('');
  return (
    <main
      className="ui-next"
      style={{ minHeight: '100dvh', background: 'var(--un-bg)', color: 'var(--un-text)', padding: '24px 0' }}
    >
      <button className="un-btn" onClick={() => setSettings(!settings)}>
        {settings ? '목록으로' : '번역 설정'}
      </button>
      {settings ? (
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 20 }}>
          <TranslationPage />
        </div>
      ) : (
        <>
          <section className="un-row" aria-label="합성 소스 목록">
            <header className="un-row-head">
              <h2>소스 작품</h2>
            </header>
            <RowRail count={titles.length}>
              {titles.map((title) => (
                <DiscoveryCard key={title} work={{ id: title, title, open: () => setSelected(title) }} />
              ))}
            </RowRail>
          </section>
          {selected && <Selected original={selected} />}
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RuntimeProvider runtime={runtime}>
      <Harness />
    </RuntimeProvider>
  </StrictMode>,
);
