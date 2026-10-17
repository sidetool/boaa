import type { EncodingMode, ChapterSplitMode } from '../../domain/types';
import type { RemoteRequest, RemoteUploadStatus } from './remote-api-contracts';
export type RemoteImportJobStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';

export type RemoteImportJobStage =
  'queued' | 'reading' | 'decoding' | 'splitting_chapters' | 'writing' | 'ready' | 'failed' | 'cancelled';

export interface RemoteImportJob {
  id: string;
  upload_id: string;
  status: RemoteImportJobStatus;
  stage?: RemoteImportJobStage;
  bytes_read?: number | string;
  total_bytes?: number | string;
  chapters_detected?: number;
  paragraphs_written?: number;
  progress_completed?: number | string | null;
  progress_total?: number | string | null;
  progress_unit?: 'images' | 'paragraphs' | null;
  message?: string;
  book_id?: string;
  error_message?: string;
  updated_at?: string;
}

/** Endpoint contracts only; the client retains authentication, timeout and error handling. */
export class RemoteImportTransport {
  constructor(private readonly request: RemoteRequest) {}
  initUpload(
    input: {
      fileName: string;
      sizeBytes: number;
      contentType: string;
      encoding: EncodingMode;
      chapterSplitMode?: ChapterSplitMode;
      importMode?: 'replace_book' | 'append_image_series' | 'append_local_archive';
      baseActiveContentRevisionId?: string;
      expectedBase?: import('@boaa/contracts').ImportExpectedBase;
      totalChunks: number;
      clientBookId?: string;
      sourceContentHash?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ uploadId: string; chunkUrlTemplate: string }> {
    return this.request('/uploads/init', { method: 'POST', body: JSON.stringify(input), signal });
  }

  getUpload(uploadId: string, signal?: AbortSignal): Promise<RemoteUploadStatus> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}`, { signal });
  }

  putUploadChunk(
    uploadId: string,
    chunkIndex: number,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<{ ok: true; upload?: RemoteUploadStatus }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, {
      method: 'PUT',
      body: chunk,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    });
  }

  completeUpload(uploadId: string, signal?: AbortSignal): Promise<{ jobId: string; statusUrl: string }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', signal });
  }

  cancelUpload(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; cancellationState?: 'requested' | 'cancelled'; upload?: RemoteUploadStatus }> {
    return this.request(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', signal });
  }

  getImportJob(jobId: string, signal?: AbortSignal): Promise<RemoteImportJob> {
    return this.request(`/import-jobs/${encodeURIComponent(jobId)}`, { signal });
  }
}
