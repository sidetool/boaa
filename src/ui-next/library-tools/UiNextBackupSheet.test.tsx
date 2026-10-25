import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import UiNextBackupSheet from './UiNextBackupSheet';
import type { BackupFeatureController } from '../../features/backup/useBackupController';

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

function controller(overrides: Partial<BackupFeatureController> = {}): BackupFeatureController {
  return {
    open: true,
    busy: false,
    available: true,
    defaultResolution: 'skip',
    conflictResolutions: { book_1: 'copy' },
    usesPlatformPicker: false,
    inspection: {
      manifest: {
        format: 'boaa-backup',
        version: 1,
        exportedAt: '2026-07-13T00:00:00.000Z',
        appVersion: '0.1.0',
        books: [{ id: 'book_1', format: 'txt', title: '백업 소설' }],
        entries: [],
        assetBlobs: [],
      },
      conflicts: [{ bookId: 'book_1', title: '백업 소설', existingTitle: '기존 소설' }],
      archiveByteLength: 1024,
      totalUncompressedBytes: 2048,
      warnings: [],
    },
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    exportBackup: vi.fn(async () => undefined),
    pickBackupFile: vi.fn(async () => undefined),
    inspectFile: vi.fn(async () => undefined),
    restoreBackup: vi.fn(async () => undefined),
    setDefaultResolution: vi.fn(),
    setConflictResolution: vi.fn(),
    ...overrides,
  };
}

describe('UiNextBackupSheet', () => {
  it('renders export, validated restore and per-book conflict controls', () => {
    const markup = renderToStaticMarkup(<UiNextBackupSheet controller={controller()} />);

    expect(markup).toContain('백업과 복원');
    expect(markup).toContain('백업 만들기');
    expect(markup).toContain('파일 고르기');
    expect(markup).toContain('백업 소설');
    expect(markup).toContain('하나 더 추가');
    expect(markup).toContain('확인한 백업 복원하기');
  });

  it('shows an explicit unsupported state instead of inactive controls', () => {
    const markup = renderToStaticMarkup(<UiNextBackupSheet controller={controller({ available: false })} />);
    expect(markup).toContain('여기서는 전체 백업을 쓸 수 없어요');
    expect(markup).not.toContain('파일 고르기');
  });
});

it('shows the operation and measured bytes inline without a progress details action', () => {
  const markup = renderToStaticMarkup(
    <UiNextBackupSheet
      controller={controller({
        busy: true,
        operation: 'inspect',
        progress: { phase: 'uploading', completed: 1024, total: 2048, unit: 'bytes' },
      })}
    />,
  );
  expect(markup).toContain('50%');
  expect(markup).toContain('파일 확인 중');
  expect(markup).toContain('업로드 중');
  expect(markup).toContain('1 KB / 2 KB');
  expect(markup).not.toContain('상세 보기');
});
