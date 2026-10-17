import { useOriginalFilesModel } from './use-original-files-model';
import { Download, RefreshCw } from 'lucide-react';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { Dialog } from '../../shared/ui/Dialog';
import './original-files.css';

function fileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function OriginalFilesDialog({
  book,
  repository,
  onClose,
  onLegacyExport,
}: {
  book: { id: string; title: string };
  repository: BookAssetRepository;
  onClose(): void;
  onLegacyExport(): void;
}) {
  const {
    files,
    error: issue,
    pending,
    requested: didRequest,
    visible,
    refresh,
    showMore,
    download,
    downloadAll,
  } = useOriginalFilesModel({ book, repository });
  const error =
    issue === 'list_failed'
      ? '원본 목록을 불러오지 못했습니다. 다시 시도해 주세요.'
      : issue === 'download_failed'
        ? '다운로드를 시작하지 못했습니다. 다시 시도해 주세요.'
        : '';
  const requested = didRequest ? '다운로드를 요청했습니다. 진행 상황은 브라우저에서 확인하세요.' : '';

  return (
    <Dialog open title="원본 다운로드" onClose={onClose} className="original-files-dialog">
      <p className="original-files-title">{book.title}</p>
      <p className="muted">원본 파일을 저장합니다. 읽기 기록은 백업에 포함됩니다.</p>
      {files === undefined && !error && <p role="status">원본 목록을 불러오는 중…</p>}
      {error && (
        <div className="original-files-error" role="alert">
          <span>{error}</span>
          {files === undefined && (
            <button className="ghost-btn" type="button" onClick={refresh}>
              <RefreshCw size={16} aria-hidden="true" /> 다시 시도
            </button>
          )}
        </div>
      )}
      {files === null && (
        <button className="ghost-btn" type="button" onClick={onLegacyExport}>
          원본 파일 저장
        </button>
      )}
      {files && (
        <>
          {files.length > 1 && (
            <button
              className="ghost-btn"
              type="button"
              disabled={pending !== undefined}
              onClick={() => void downloadAll()}
            >
              <Download size={18} aria-hidden="true" /> 전체 원본 ZIP 저장
            </button>
          )}
          <ul className="original-files-list">
            {files.slice(0, visible).map((file) => (
              <li key={file.id}>
                <div>
                  <span className="original-files-name">{file.fileName}</span>
                  <small className="muted">{fileSize(file.byteLength)}</small>
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  disabled={pending !== undefined}
                  aria-label={`${file.fileName} 다운로드`}
                  aria-busy={pending === file.id}
                  onClick={() => void download(file)}
                >
                  <Download size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {files.length > visible && (
            <button className="ghost-btn" type="button" onClick={showMore}>
              더 보기
            </button>
          )}
          {!files.length && <p>보관된 원본 파일이 없습니다.</p>}
        </>
      )}
      {requested && (
        <p className="muted" role="status">
          {requested}
        </p>
      )}
    </Dialog>
  );
}
