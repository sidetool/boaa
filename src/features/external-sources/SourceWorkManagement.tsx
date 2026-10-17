import { useSourceWorkManagementModel } from './use-source-work-management-model';
import { Download, FilePenLine, RotateCcw, Trash2 } from 'lucide-react';
import type { Novel } from '../../domain/types';
import type { LibraryScreenProps } from '../library/library-screen-contract';
import { BookFileFacts } from '../library/BookFileFacts';
import { formatReadingDuration } from '../library/library-screen-model';
import type { ExternalSourceController } from './external-source-controller-contract';

export function SourceWorkManagement({
  novel,
  controller,
  library,
}: {
  novel?: Novel;
  controller: ExternalSourceController;
  library: LibraryScreenProps;
}) {
  const { id, time, seconds, remove, editMetadata, downloadSource, resetHistory, resetDisabled, removeDisabled } =
    useSourceWorkManagementModel({ novel, controller, library });

  return (
    <details className="book-management-disclosure">
      <summary>
        <span>작품 관리 및 파일 정보</span>
      </summary>
      <div className="book-management-body">
        {novel ? (
          <BookFileFacts novel={novel} className="book-management-facts" />
        ) : (
          <dl className="book-management-facts">
            <div>
              <dt>원본 파일</dt>
              <dd>스트리밍 · 저장된 파일 없음</dd>
            </div>
            <div>
              <dt>전체 회차</dt>
              <dd>{controller.activeSubscription?.availableReleaseCount ?? '정보 없음'}</dd>
            </div>
          </dl>
        )}
        {id && (!novel || (seconds ?? 0) > 0) && (
          <dl className="book-management-facts">
            <div>
              <dt>{novel ? '스트리밍 독서 · 이 기기' : '누적 독서 · 이 기기'}</dt>
              <dd>
                {seconds === undefined
                  ? time?.id === id
                    ? '확인하지 못함'
                    : '확인 중…'
                  : seconds > 0
                    ? formatReadingDuration(seconds)
                    : '기록 없음'}
              </dd>
            </div>
          </dl>
        )}
        <div className="book-management-actions">
          {novel && (
            <>
              <button type="button" onClick={editMetadata}>
                <FilePenLine size={17} /> 작품 정보 편집
              </button>
              <button type="button" disabled={!novel.sourceAssetId} onClick={() => void downloadSource()}>
                <Download size={17} /> 원본 다운로드
              </button>
            </>
          )}
          <button type="button" disabled={resetDisabled} onClick={() => void resetHistory()}>
            <RotateCcw size={17} /> 읽은 기록 초기화
          </button>
          {(novel || controller.activeSubscription) && (
            <button type="button" className="danger" disabled={removeDisabled} onClick={remove}>
              <Trash2 size={17} /> 휴지통으로 이동
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
