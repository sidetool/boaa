import { useEffect, useRef } from 'react';
import {
  useStorageBookManagerModel,
  type StorageManagement,
  type StorageBookSort,
  type StorageBookConfirmation,
} from './use-storage-book-manager-model';
export type { StorageManagement } from './use-storage-book-manager-model';
import { ArrowLeft, RefreshCw, Search, BookOpen, Trash2 } from 'lucide-react';
import type { LibraryStorageUsage } from '../../domain/types';
import { formatStorageBytes } from './DeviceStorageEstimate';

function confirmStorageMutation({ action, count, titles }: StorageBookConfirmation) {
  const label = action === 'purge' ? '영구 삭제' : action === 'restore' ? '복원' : '휴지통 이동';
  return window.confirm(
    `${titles.slice(0, 3).join(', ')}${count > 3 ? ' 외' : ''}\n선택한 ${count}개 작품을 ${label}할까요?${action === 'purge' ? '\n원본과 독서 기록이 삭제되며 되돌릴 수 없습니다.' : action === 'moveToTrash' ? '\n공간을 비우려면 휴지통에서 영구 삭제해야 합니다.' : ''}`,
  );
}

export function StorageBookManager({
  usage,
  management,
  refresh,
  onBack,
  onBusyChange,
  initialTrash = false,
}: {
  usage: LibraryStorageUsage;
  management?: StorageManagement;
  refresh(): Promise<void>;
  onBack(): void;
  onBusyChange?(busy: boolean): void;
  initialTrash?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const content = heading.current?.closest('.reader-settings-content');
    if (content) content.scrollTop = 0;
  }, []);
  const {
    trash,
    query,
    sort,
    setSort,
    limit,
    selected,
    busy,
    result,
    books,
    targets,
    disabled,
    changeLocation,
    changeQuery,
    select,
    refreshList,
    mutate,
    loadMore,
    visibleBooks,
    selectedBytes,
    locationCounts,
  } = useStorageBookManagerModel({
    usage,
    management,
    refresh,
    onBusyChange,
    initialTrash,
    confirm: confirmStorageMutation,
  });
  const label = result?.action === 'purge' ? '영구 삭제' : result?.action === 'restore' ? '복원' : '휴지통 이동';
  const message = !result
    ? ''
    : result.refreshFailed
      ? `${result.completed}개 ${label} 완료. 목록을 새로고침해 주세요.`
      : `${result.completed}개 ${label} 완료${result.remaining ? ` · ${result.remaining}개 미처리. 목록을 확인하고 다시 선택해 주세요.` : ''}${result.action === 'purge' && result.completed ? ' 저장공간 반영에는 시간이 걸릴 수 있습니다.' : ''}`;

  return (
    <div className="storage-book-manager" aria-busy={busy}>
      <div className="storage-summary-heading storage-manager-heading">
        <button type="button" className="icon-btn" aria-label="사용량 요약" onClick={onBack} disabled={busy}>
          <ArrowLeft size={18} />
        </button>
        <h3 ref={heading} tabIndex={-1}>
          작품별 관리
        </h3>
        <button
          type="button"
          className="icon-btn"
          aria-label="작품 용량 새로고침"
          disabled={busy}
          onClick={() => void refreshList()}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="storage-location-switch" role="group" aria-label="작품 위치">
        {[false, true].map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={trash === value}
            disabled={busy}
            onClick={() => changeLocation(value)}
          >
            {value ? <Trash2 size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
            {value ? '휴지통' : '책장'} <span>{value ? locationCounts.trash : locationCounts.library}</span>
          </button>
        ))}
      </div>
      <div className="storage-book-controls">
        <label className="storage-book-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">작품 검색</span>
          <input
            type="search"
            placeholder="작품 검색"
            value={query}
            disabled={busy}
            onChange={(e) => changeQuery(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">정렬</span>
          <select value={sort} disabled={busy} onChange={(e) => setSort(e.target.value as StorageBookSort)}>
            <option value="size">용량 큰 순</option>
            <option value="name">이름순</option>
          </select>
        </label>
      </div>
      <p className="storage-list-caption">
        {books.length}개 작품{trash ? ' · 영구 삭제하면 복구할 수 없습니다.' : ' · 정리할 작품을 선택하세요.'}
      </p>
      {management?.blocked && <p role="status">독서·다운로드·가져오기를 마친 뒤 정리할 수 있습니다.</p>}
      {busy ? <p role="status">처리 중…</p> : message && <p role="status">{message}</p>}
      <ul className="storage-book-list">
        {visibleBooks.map((book) => (
          <li key={book.id} data-selected={selected.has(book.id) || undefined}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(book.id)}
                disabled={disabled}
                onChange={(e) => select(book.id, e.target.checked)}
              />
              <span>{book.title}</span>
              <strong>{formatStorageBytes(book.bytes)}</strong>
            </label>
          </li>
        ))}
      </ul>
      {(targets.length > 0 || busy) && (
        <div className="storage-book-actions storage-selection-bar">
          <span>
            {targets.length}개 선택 · {formatStorageBytes(selectedBytes)}
          </span>
          <button
            type="button"
            className="ghost-btn"
            disabled={disabled || !targets.length}
            onClick={() => void mutate(trash ? 'restore' : 'moveToTrash')}
          >
            {trash ? '복원' : '휴지통 이동'}
          </button>
          {trash && (
            <button
              type="button"
              className="ghost-btn"
              disabled={disabled || !targets.length}
              onClick={() => void mutate('purge')}
            >
              영구 삭제
            </button>
          )}
        </div>
      )}
      {!books.length && (
        <div className="storage-empty">
          <BookOpen size={28} aria-hidden="true" />
          <p>{query ? '검색 결과가 없습니다.' : trash ? '휴지통이 비어 있습니다.' : '저장된 작품이 없습니다.'}</p>
        </div>
      )}
      {books.length > limit && (
        <button type="button" className="ghost-btn" onClick={loadMore}>
          더 보기
        </button>
      )}
    </div>
  );
}
