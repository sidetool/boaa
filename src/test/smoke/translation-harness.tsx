import { StrictMode, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProvider } from '../../app/runtime/RuntimeProvider';
import type { AppRuntime } from '../../app/runtime/app-runtime';
import { RemoteApiClient } from '../../services/remote/remote-api-client';
import UiNextSettingsPanel from '../../ui-next/settings/UiNextSettingsPanel';
import type { ReaderSettingsPanelProps } from '../../features/reader-settings/settings-panel-contract';
import { DEFAULT_GESTURE_BINDINGS, DEFAULT_READING_PROFILE } from '../../features/reader-settings/reading-profile';
import { UiNextReaderChrome } from '../../ui-next/reader/UiNextReaderChrome';
import type { ReaderChromeProps } from '../../features/reader/reader-chrome-contract';
import { ReaderTranslationControls } from '../../ui-next/reader/ReaderTranslationControls';
import { useReaderTranslation } from '../../features/translation/use-reader-translation';
import { ReaderTranslationContext } from '../../features/translation/reader-translation-context';
import { ReaderScreenHandle, type ReaderScreenModel } from '../../features/reader/reader-screen-contract';
import { ReaderViewport, type ReaderViewportApi } from '../../features/reader/ReaderViewport';
import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import { defaultSettings, PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import type { Chapter, Paragraph } from '../../domain/types';
import '../../styles/tokens.css';
import '../../styles/base.css';
import '../../styles/reader-shell.css';
import '../../styles/reader-content.css';
import '../../ui-next/styles/tokens.css';
import '../../ui-next/styles/kit.css';
import '../../ui-next/styles/components.css';
import '../../ui-next/settings/settings.css';

const api = new RemoteApiClient('/api');
const runtime = {
  platformRuntime: { kind: 'browser' },
  readerRuntime: { mode: 'remote', remoteApiClient: api },
} as unknown as AppRuntime;
const paragraphs: Paragraph[] = Array.from({ length: 100 }, (_, i) => ({
  id: `p${i + 1}`,
  novelId: 'synthetic-book',
  chapterId: 'synthetic-chapter',
  index: i + 1,
  text: `${i + 1} これは日本語の物語です。 ${'静かな部屋で本を読みます。'.repeat(3 + (i % 8))}`,
  textHash: `h${i}`,
  startOffsetInChapter: i * 100,
  endOffsetInChapter: (i + 1) * 100,
}));
const chapter = {
  id: 'synthetic-chapter',
  novelId: 'synthetic-book',
  index: 1,
  title: '검증용 회차',
  textHash: 'fixture',
  paragraphCount: paragraphs.length,
  characterCount: 12000,
} as Chapter;
const repository: ReaderBodyRepository = {
  getChapter: async () => chapter,
  getParagraph: async (id) => paragraphs.find((p) => p.id === id),
  getParagraphPage: async (_id, pageIndex) => ({
    id: `page-${pageIndex}`,
    novelId: 'synthetic-book',
    chapterId: chapter.id,
    pageIndex,
    startParagraphIndex: pageIndex * PARAGRAPHS_PER_PAGE + 1,
    endParagraphIndex: (pageIndex + 1) * PARAGRAPHS_PER_PAGE,
    paragraphs: paragraphs.slice(pageIndex * PARAGRAPHS_PER_PAGE, (pageIndex + 1) * PARAGRAPHS_PER_PAGE),
    textHash: 'fixture',
  }),
  getSettings: async () => defaultSettings,
  getReadingPosition: async () => undefined,
  saveReadingPosition: async () => undefined,
  searchParagraphPage: async () => ({ matches: [], nextCursor: undefined }) as never,
};
const model = {
  novel: {
    id: 'synthetic-book',
    title: '합성 테스트 작품',
    format: 'txt',
    totalChapters: 1,
    activeContentRevisionId: 'revision',
  },
  chapter,
  settings: defaultSettings,
  chapters: [chapter],
} as unknown as ReaderScreenModel;
const handle = new ReaderScreenHandle();
const noop = () => undefined;
function Reader() {
  const translation = useReaderTranslation(model, repository);
  const apiRef = useRef<ReaderViewportApi>();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [viewport, setViewport] = useState<ReaderViewportApi>();
  return (
    <main
      className="reader-screen chrome-visible"
      style={{ '--reading-margin-y': '80px', '--reading-margin-x': '24px' } as CSSProperties}
    >
      <UiNextReaderChrome
        model={model}
        screenHandle={handle}
        viewport={viewport}
        chrome={{ fullscreen: false, toggleFullscreen: noop } as unknown as ReaderChromeProps['chrome']}
        search={{ query: '', setQuery: noop, handleInputKeyDown: noop } as unknown as ReaderChromeProps['search']}
        mode="read"
        readingFlow="scroll"
        mobileSearchOpen={false}
        overflowOpen={overflowOpen}
        onSetMode={noop}
        onMobileSearchOpenChanged={noop}
        onOverflowOpenChanged={setOverflowOpen}
        onGoToSavedPosition={noop}
        onOpenTranslation={translation.available ? () => translation.setOpen(true) : undefined}
      />
      <ReaderTranslationControls controller={translation} listening={false} />
      <ReaderTranslationContext.Provider value={translation.texts}>
        <ReaderViewport
          repository={repository}
          novel={model.novel}
          chapter={chapter}
          chapters={[chapter]}
          settings={defaultSettings}
          readingFlow="scroll"
          mode="read"
          search={{ highlightQuery: '' }}
          screenHandle={handle}
          apiRef={apiRef}
          onApiReady={() => setViewport(apiRef.current)}
          onVisualLocation={noop}
          onSelectionChanged={noop}
          onRevealChrome={noop}
          onToggleImmersive={noop}
          onPageIntent={noop}
          onScrollIntent={noop}
          onDocumentLink={noop}
        />
      </ReaderTranslationContext.Provider>
    </main>
  );
}
const reader = new URLSearchParams(location.search).has('reader');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RuntimeProvider runtime={runtime}>
      {reader ? (
        <Reader />
      ) : (
        <UiNextSettingsPanel
          controller={
            {
              open: true,
              settings: defaultSettings,
              saveStatus: 'idle',
              saveError: false,
              isDirty: false,
              closePanel: noop,
              updateSettings: noop,
            } as unknown as ReaderSettingsPanelProps['controller']
          }
          profile={DEFAULT_READING_PROFILE}
          bookOverrideEnabled={false}
          contrastWarning={false}
          gestureBindings={DEFAULT_GESTURE_BINDINGS}
          platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'smoke' }}
          providerExecutionRuntime="server"
          extensions={[]}
          externalSources={{ sources: [] } as unknown as ReaderSettingsPanelProps['externalSources']}
          openSync={noop}
          openBackup={noop}
          updateProfile={noop}
          setBookOverrideEnabled={noop}
          resetProfile={noop}
          updateGestureBindings={noop}
          setExtensionEnabled={noop}
        />
      )}
    </RuntimeProvider>
  </StrictMode>,
);
