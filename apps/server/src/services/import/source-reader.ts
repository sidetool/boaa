import type pg from 'pg';
import type { ChapterSplitMode, EncodingMode } from '@boaa/contracts';
import type { ServerConfig } from '../../config.js';
import { localUploadLimit } from '../local-archive-policy.js';
import { validateUploadCompleteness } from '../upload-validation.js';
import { assembleUploadFile } from '../upload-file.js';
import { uploadDirectory } from '../upload-cleanup.js';

interface UploadSessionRow {
  id: string;
  user_id: string;
  file_name: string;
  size_bytes: string;
  content_type: string;
  encoding: EncodingMode;
  chapter_split_mode?: ChapterSplitMode;
  total_chunks: number | null;
  client_book_id?: string | null;
  source_content_hash?: string | null;
  import_mode?: 'replace_book' | 'append_image_series' | 'append_local_archive';
  base_active_content_revision_id?: string | null;
  expected_base?: import('@boaa/contracts').ImportExpectedBase | null;
}

interface UploadChunkRow {
  chunk_index: number;
  size_bytes: number;
  storage_path: string;
}

export async function readUploadFile(
  pool: pg.Pool,
  config: ServerConfig,
  uploadId: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number) => Promise<void>,
) {
  const sessionResult = await pool.query<UploadSessionRow>(
    'select * from upload_sessions where id = $1 and user_id=$2',
    [uploadId, config.defaultUserId],
  );
  const session = sessionResult.rows[0];
  if (!session) throw new Error(`Upload session not found: ${uploadId}`);
  if (Number(session.size_bytes) > localUploadLimit(config, session.file_name, session.import_mode))
    throw new Error('파일 크기가 이 형식의 서버 업로드 한도를 초과했습니다.');

  const chunksResult = await pool.query<UploadChunkRow>(
    'select chunk_index, size_bytes, storage_path from upload_chunks where upload_id = $1 order by chunk_index asc',
    [uploadId],
  );
  if (!chunksResult.rows.length) throw new Error(`Upload has no chunks: ${uploadId}`);

  const validation = validateUploadCompleteness({
    expectedBytes: Number(session.size_bytes),
    totalChunks: session.total_chunks,
    chunks: chunksResult.rows.map((chunk) => ({
      chunkIndex: Number(chunk.chunk_index),
      sizeBytes: Number(chunk.size_bytes),
    })),
  });
  if (!validation.ok) {
    throw new Error(`Upload is incomplete: ${validation.error}`);
  }

  const file = await assembleUploadFile({
    directory: uploadDirectory(config, uploadId),
    expectedBytes: Number(session.size_bytes),
    chunks: chunksResult.rows,
    signal,
    onProgress,
  });
  return { session, ...file };
}

export function arrayBufferFromBuffer(buffer: Buffer): ArrayBuffer {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
