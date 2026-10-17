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
    return withRequestProgress(
      this.transport.request,
      `/backups/staged/${encodeURIComponent(id)}/restore`,
      {
        method: 'POST',
        headers: {
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

  restoreBackup(
    archive: Blob,
    options: BackupRestoreOptions,
    onProgress?: TaskProgressCallback,
  ): Promise<BackupRestoreResult> {
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
