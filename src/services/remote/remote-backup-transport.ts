import type { TaskProgressCallback } from '@boaa/contracts';
import type { BackupInspection, BackupRestoreOptions, BackupRestoreResult } from '../../repositories/backup-repository';
import { withRequestProgress } from './request-progress';

interface BackupTransportPort {
  request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  requestBlob(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
    onProgress?: TaskProgressCallback,
  ): Promise<{ blob: Blob; headers: Headers; status: number }>;
}

// Leave room for authentication, cookies and proxy headers on legacy uploads.
function fitsRestoreHeaders(overrides: string): boolean {
  return overrides.length <= 4096 && !/[^\x20-\x7e]/.test(overrides);
}

/** Backup wire protocol. Authentication, cancellation and timeout handling belong to the shared transport. */
export class RemoteBackupTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly transport: BackupTransportPort,
  ) {}

  exportBackup(onProgress?: TaskProgressCallback): Promise<{ blob: Blob; headers: Headers; status: number }> {
    return this.transport.requestBlob('/backups/export', {}, undefined, onProgress);
  }

  async createBackupDownload(): Promise<string> {
    const { ticket } = await this.transport.request<{ ticket: string }>('/backups/download', { method: 'POST' });
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('다운로드 주소를 확인하지 못했습니다.');
    return `${this.baseUrl}/backups/download/${ticket}`;
  }

  discardBackupInspection(id: string): Promise<void> {
    return this.transport.request(`/backups/staged/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  restoreInspectedBackup(
    id: string,
    options: BackupRestoreOptions,
    onProgress?: TaskProgressCallback,
  ): Promise<BackupRestoreResult> {
    const overrides = JSON.stringify(options.conflictResolutions ?? {});
    const init: RequestInit = fitsRestoreHeaders(overrides)
      ? {
          headers: {
            'X-Backup-Default-Resolution': options.defaultConflictResolution,
            'X-Backup-Conflict-Resolutions': overrides,
          },
        }
      : {
          // Older servers reject this marker before consuming the staged archive.
          headers: { 'Content-Type': 'application/json', 'X-Backup-Default-Resolution': 'body' },
          body: JSON.stringify(options),
        };
    return withRequestProgress(
      this.transport.request,
      `/backups/staged/${encodeURIComponent(id)}/restore`,
      { method: 'POST', ...init },
      60 * 60_000,
      onProgress,
      '/backups/progress',
    );
  }

  inspectBackup(archive: Blob, onProgress?: TaskProgressCallback): Promise<BackupInspection> {
    return withRequestProgress(
      this.transport.request,
      '/backups/inspect',
      {
        method: 'POST',
        body: archive,
        headers: { 'Content-Type': 'application/zip' },
      },
      60 * 60_000,
      onProgress,
      '/backups/progress',
    );
  }

  async restoreBackup(
    archive: Blob,
    options: BackupRestoreOptions,
    onProgress?: TaskProgressCallback,
  ): Promise<BackupRestoreResult> {
    if (!fitsRestoreHeaders(JSON.stringify(options.conflictResolutions ?? {}))) {
      const inspection = await this.inspectBackup(archive, onProgress);
      if (!inspection.stagedId) throw new Error('서버가 대용량 복원 선택 목록을 지원하지 않습니다.');
      try {
        return await this.restoreInspectedBackup(inspection.stagedId, options, onProgress);
      } catch (error) {
        await this.discardBackupInspection(inspection.stagedId).catch(() => undefined);
        throw error;
      }
    }
    return withRequestProgress(
      this.transport.request,
      '/backups/restore',
      {
        method: 'POST',
        body: archive,
        headers: {
          'Content-Type': 'application/zip',
          'X-Backup-Default-Resolution': options.defaultConflictResolution,
          ...(options.conflictResolutions
            ? { 'X-Backup-Conflict-Resolutions': JSON.stringify(options.conflictResolutions) }
            : {}),
        },
      },
      60 * 60_000,
      onProgress,
      '/backups/progress',
    );
  }
}
