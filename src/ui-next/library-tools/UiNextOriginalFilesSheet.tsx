import { Download, FileDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { useOriginalFilesModel } from '../../features/library/use-original-files-model';
import { formatBytes } from '../../utils/format';
import { Sheet } from '../components/primitives';
import { EmptyState, Notice, PrefSkeleton } from '../components/prefs';
import './library-tools.css';

/** 원본 받기: the files a work was imported from, one by one or all in a ZIP. */
export function UiNextOriginalFilesSheet({
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
  const model = useOriginalFilesModel({ book, repository });
  const { files } = model;
  return (
    <Sheet
      open
      onClose={onClose}
      title="원본 받기"
      footer={
        files && files.length > 1 ? (
          <button
            type="button"
            className="un-btn is-primary un-tools-wide"
            disabled={model.pending !== undefined}
            onClick={() => void model.downloadAll()}
          >
            <Download size={17} />
            전부 ZIP으로 받기
          </button>
        ) : undefined
      }
    >
      <div className="un-tools">
        <p className="un-tools-note">‘{book.title}’을 가져올 때 쓴 파일이에요. 읽기 기록은 백업에 들어가요.</p>
        {files === undefined && !model.error && <PrefSkeleton rows={2} />}
        {model.error && (
          <Notice
            tone="danger"
            action={
              files === undefined ? (
                <button type="button" className="un-btn is-text is-sm" onClick={model.refresh}>
                  <RefreshCw size={14} />
                  다시
                </button>
              ) : undefined
            }
          >
            {model.error === 'list_failed' ? '원본 목록을 불러오지 못했어요.' : '받기를 시작하지 못했어요.'}
          </Notice>
        )}
        {files === null && (
          <button type="button" className="un-btn is-ghost" onClick={onLegacyExport}>
            <FileDown size={16} />
            원본 파일 저장
          </button>
        )}
        {files && files.length > 0 && (
          <ul className="un-shelf-list">
            {files.slice(0, model.visible).map((file) => (
              <li key={file.id}>
                <span className="un-shelf-name">
                  {file.fileName}
                  <small>{formatBytes(file.byteLength)}</small>
                </span>
                <button
                  type="button"
                  className="un-icon-btn is-sm"
                  aria-label={`${file.fileName} 받기`}
                  aria-busy={model.pending === file.id}
                  disabled={model.pending !== undefined}
                  onClick={() => void model.download(file)}
                >
                  {model.pending === file.id ? <LoaderCircle size={16} className="un-spin" /> : <Download size={16} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {files && files.length > model.visible && (
          <button type="button" className="un-btn is-ghost is-sm un-tools-center" onClick={model.showMore}>
            더 보기
          </button>
        )}
        {files && !files.length && <EmptyState title="보관된 원본이 없어요" />}
        {model.requested && <Notice>받기를 요청했어요. 진행은 브라우저 다운로드에서 볼 수 있어요.</Notice>}
      </div>
    </Sheet>
  );
}
