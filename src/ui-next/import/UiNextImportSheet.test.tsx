import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ImportFeatureController } from '../../features/import/useImportController';
import { testNovel } from '../../features/book-workspace/book-workspace-test-fixtures';
import { UiNextImportSheet } from './UiNextImportSheet';

vi.mock('../components/primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/primitives')>()),
  Sheet: ({ children, footer, title }: { children: ReactNode; footer?: ReactNode; title: string }) => (
    <section role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      {children}
      {footer}
    </section>
  ),
}));

function controller(overrides: Partial<ImportFeatureController> = {}): ImportFeatureController {
  return {
    isOpen: true,
    busy: false,
    tasks: [],
    pendingFiles: [],
    duplicateBusy: false,
    duplicateConflicts: [],
    seriesBusy: false,
    seriesTargetLocked: false,
    encoding: 'auto',
    chapterSplitMode: 'auto',
    uploadSessions: [],
    usesPlatformPicker: false,
    supportsArchivePassword: true,
    archivePassword: '',
    libraryDrop: {
      active: false,
      actions: {
        enter: vi.fn(),
        over: vi.fn(),
        leave: vi.fn(),
        drop: vi.fn(),
        dropOnEmptyState: vi.fn(),
      },
    },
    open: vi.fn(),
    openChapterAppend: vi.fn(),
    close: vi.fn(),
    selectFiles: vi.fn(),
    pickFiles: vi.fn(),
    importFiles: vi.fn(),
    startPendingImport: vi.fn(),
    previewPendingImport: vi.fn(),
    cancelImport: vi.fn(),
    dismissTask: vi.fn(),
    setEncoding: vi.fn(),
    setChapterSplitMode: vi.fn(),
    setDuplicatePolicy: vi.fn(),
    setSeriesTargetNovel: vi.fn(),
    setArchivePassword: vi.fn(),
    forgetUploadSession: vi.fn(),
    ...overrides,
  };
}

describe('UiNextImportSheet', () => {
  it('offers explicit reparse/replace alongside open, skip and copy for identical source bytes', () => {
    const file = new File(['body'], 'book.txt');
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          pendingFiles: [file],
          duplicateConflicts: [
            {
              fileKey: 'file',
              fileName: file.name,
              kind: 'same_source',
              policy: 'open_existing',
              existingBook: testNovel(),
            },
          ],
        })}
      />,
    );
    expect(markup).toContain('value="replace"');
    expect(markup).toContain('현재 설정으로 다시 가져와 바꾸기');
    for (const policy of ['open_existing', 'skip', 'copy']) expect(markup).toContain(`value="${policy}"`);
  });

  it('offers a list refresh after committed import without prompting another upload', () => {
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          refreshPendingBooks: [{ id: 'book', fileName: 'book.txt' }],
          retryPendingRefresh: vi.fn(),
        })}
      />,
    );
    expect(markup).toContain('작품은 저장했지만 목록을 갱신하지 못했어요.');
    expect(markup).toContain('파일을 다시 가져올 필요는 없어요.');
    expect(markup).toContain('목록 갱신 다시 시도');
  });

  it('preserves the import copy and accessible dialog/file controls', () => {
    const markup = renderToStaticMarkup(<UiNextImportSheet controller={controller()} />);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('책 가져오기');
    expect(markup).toContain('파일 고르기');
    expect(markup).toContain(
      'accept=".txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed"',
    );
    expect(markup).toContain('회차가 잘못 나뉘면 다른 방식을 골라 보세요.');
    expect(markup).toMatch(/<label[^>]*>[\s\S]*글자 인코딩[\s\S]*<select/);
    expect(markup).toMatch(/<label[^>]*>[\s\S]*화 나누기[\s\S]*<select/);
  });

  it('offers the extended encodings for text imports and keeps the selection', () => {
    const markup = renderToStaticMarkup(<UiNextImportSheet controller={controller({ encoding: 'shift_jis' })} />);
    expect(markup).toContain('value="shift_jis" selected=""');
    expect(markup).toContain('UTF-16 BE');
    expect(markup).toContain('GB18030 / GBK');
    expect(markup).toContain('Big5');
    expect(markup).toContain('ISO-2022-JP');
  });

  it('renders selected files, import progress, and resumable upload sessions', () => {
    const selectedFile = { name: '연재본.txt', size: 2048, lastModified: 1 } as File;
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          busy: true,
          pendingFiles: [selectedFile],
          progress: {
            jobId: 'job-1',
            status: 'reading',
            subphase: 'reading_chunks',
            bytesRead: 1024,
            totalBytes: 2048,
            chaptersDetected: 3,
            paragraphsWritten: 20,
            message: '파일을 읽는 중입니다.',
          },
          batch: { total: 1, current: 1, completed: 0, failed: 0, skipped: 0, currentFileName: '연재본.txt' },
          uploadSessions: [
            {
              key: 'session-1',
              uploadId: 'upload-1',
              fileName: '중단본.txt',
              sizeBytes: 4096,
              lastModified: 1,
              encoding: 'utf-8',
              chapterSplitMode: 'mixed',
              chunkBytes: 1024,
              totalChunks: 4,
              createdAt: '2026-07-10T00:00:00.000Z',
              updatedAt: '2026-07-10T00:00:00.000Z',
              expiresAt: '2026-07-17T00:00:00.000Z',
            },
          ],
        })}
      />,
    );

    expect(markup).toContain('연재본.txt');
    expect(markup).toContain('파일을 읽는 중입니다.');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('멈춘 서버 업로드');
    expect(markup).toContain('중단본.txt');
  });

  it('shows server activity without presenting uploaded bytes as completed import progress', () => {
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          busy: true,
          progress: {
            jobId: 'job',
            status: 'writing',
            subphase: 'server_processing',
            bytesRead: 100,
            totalBytes: 100,
            chaptersDetected: 1,
            paragraphsWritten: 0,
            message: '이미지 저장 45개',
          },
        })}
      />,
    );
    expect(markup).toContain('이미지 저장 45개');
    expect(markup).not.toContain('aria-valuenow=');
    expect(markup).not.toContain('100%');
  });

  it('labels failed progress as a failure instead of an active import', () => {
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          progress: {
            jobId: 'job-failed',
            status: 'failed',
            bytesRead: 0,
            totalBytes: 2048,
            chaptersDetected: 0,
            paragraphsWritten: 0,
            message: 'Bearer token을 다시 확인하세요.',
          },
        })}
      />,
    );

    expect(markup).toContain('가져오지 못했어요');
    expect(markup).not.toContain('가져오는 중');
  });

  it('shows a local series add/duplicate/conflict plan before import', () => {
    const file = new File(['chapter'], '서른의 봄 3화.cbz');
    const parsed = {
      original: file.name,
      displayBaseName: '서른의 봄 3화',
      workTitle: '서른의 봄',
      normalizedWorkKey: '서른의 봄',
      looseWorkKey: '서른의봄',
      releaseTitle: '3화',
      releaseKey: 'c:3',
      chapterNumber: 3,
      confidence: 'high' as const,
      evidence: ['chapter'],
    };
    const inspection = {
      sourceKind: 'nested_package' as const,
      workTitle: '서른의 봄',
      normalizedWorkKey: '서른의 봄',
      confidence: 'high' as const,
      releases: [
        {
          id: 'release-3',
          file,
          originalName: file.name,
          parsed,
          releaseKey: 'c:3',
          contentHash: 'hash-3',
          pageCount: 12,
        },
      ],
      candidateNovels: [],
      sourceFileNames: ['서른의 봄.zip'],
    };
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          pendingFiles: [file],
          seriesInspection: inspection,
          seriesPlan: {
            inspection,
            releases: [{ ...inspection.releases[0], disposition: 'add' }],
            addCount: 1,
            duplicateCount: 2,
            conflictCount: 1,
          },
        })}
      />,
    );

    expect(markup).toContain('연재 작품으로 가져오기');
    expect(markup).toContain('새 회차 1');
    expect(markup).toContain('이미 있음 2');
    expect(markup).toContain('충돌 1');
    expect(markup).toContain('연재 작품으로 가져오기');
  });

  it('shows a TXT or EPUB chapter merge plan for a local Library work', () => {
    const file = new File(['제2화\n\n본문'], '작품 2화.txt', { type: 'text/plain' });
    const inspection = {
      workTitle: '작품',
      normalizedWorkKey: '작품',
      format: 'txt' as const,
      sources: [],
      chapters: [
        {
          id: 'chapter-2',
          sourceId: 'source-2',
          sourceTitle: '2화',
          sourceFileName: file.name,
          sourceChapterIndex: 1,
          title: '제2화',
          textHash: 'hash-2',
          characterCount: 2,
          paragraphCount: 1,
        },
      ],
      candidateNovels: [],
    };
    const markup = renderToStaticMarkup(
      <UiNextImportSheet
        controller={controller({
          pendingFiles: [file],
          documentSeriesInspection: inspection,
          documentSeriesPlan: {
            inspection,
            targetChapters: [],
            chapters: [{ ...inspection.chapters[0], disposition: 'add' }],
            addCount: 1,
            duplicateCount: 0,
            conflictCount: 0,
          },
        })}
      />,
    );

    expect(markup).toContain('회차로 더하기');
    expect(markup).toContain('원본은 그대로 두고 새 회차만 작품에 더해요.');
    expect(markup).toContain('제2화');
    expect(markup).toContain('새 회차 1');
  });
});
