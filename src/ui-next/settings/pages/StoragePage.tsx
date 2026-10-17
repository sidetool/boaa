import { ArchiveRestore, BookOpen, ChevronLeft, Library, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { StorageCapacity, StorageUsageBreakdown } from '../../../domain/types';
import type { ExternalSourceController } from '../../../features/external-sources/useExternalSourceController';
import { formatStorageBytes } from '../../../features/reader-settings/DeviceStorageEstimate';
import type { StorageSettingsProps } from '../../../features/reader-settings/StorageSettingsPanel';
import { useDeviceStorageEstimate } from '../../../features/reader-settings/use-device-storage-estimate';
import { useSourceCacheUsage } from '../../../features/reader-settings/use-source-cache-usage';
import {
  useStorageBookManagerModel,
  type StorageBookAction,
  type StorageBookConfirmation,
  type StorageBookMutationResult,
} from '../../../features/reader-settings/use-storage-book-manager-model';
import { useStorageSettingsModel } from '../../../features/reader-settings/use-storage-settings-model';
import type { LibraryStorageUsage } from '../../../domain/types';
import { cx, Progress, Segmented, Sheet } from '../../components/primitives';
import {
  EmptyState,
  Notice,
  Pref,
  PrefFold,
  PrefGroup,
  PrefLink,
  PrefSection,
  PrefSkeleton,
} from '../../components/prefs';

const bytes = formatStorageBytes;
const BREAKDOWN: readonly [keyof StorageUsageBreakdown, string][] = [
  ['document', '문서'],
  ['image', '이미지'],
  ['audio', '오디오'],
  ['other', '기타'],
];
const ACTION_QUESTION: Record<StorageBookAction, string> = {
  moveToTrash: '휴지통으로 옮길까요?',
  restore: '복원할까요?',
  purge: '영구 삭제할까요?',
};
const ACTION_LABEL: Record<StorageBookAction, string> = {
  moveToTrash: '휴지통으로 옮기기',
  restore: '복원',
  purge: '영구 삭제',
};

function Capacity({ capacity }: { capacity?: StorageCapacity }) {
  if (!capacity || capacity.status !== 'available')
    return (
      <p className="un-storage-muted">
        {capacity?.status === 'unavailable' && capacity.reason === 'read_failed'
          ? '남은 공간을 확인하지 못했어요.'
          : '이 서버는 전체 용량을 알려 주지 않아요.'}
      </p>
    );
  const used = capacity.totalBytes - capacity.availableBytes;
  const low = capacity.availableBytes <= Math.max(capacity.minimumFreeBytes, capacity.totalBytes * 0.05);
  return (
    <div className={cx('un-storage-capacity', low && 'is-low')}>
      <p>
        <strong>{bytes(capacity.availableBytes)}</strong> 남음
      </p>
      <Progress value={used / capacity.totalBytes} label="서버 저장공간 사용량" />
      <small>전체 {bytes(capacity.totalBytes)} · 다른 서비스와 같이 써요</small>
      {low && <Notice tone="warning">저장공간이 얼마 남지 않았어요.</Notice>}
    </div>
  );
}

function UsageDetails({ usage }: { usage: LibraryStorageUsage }) {
  const cache = useSourceCacheUsage(true);
  return (
    <PrefFold title="자세히 보기" summary="파일 종류별 용량">
      {usage.breakdown ? (
        BREAKDOWN.map(([key, label]) =>
          usage.breakdown?.[key] === undefined ? null : (
            <Pref
              key={key}
              title={label}
              control={<span className="un-pref-value">{bytes(usage.breakdown[key])}</span>}
            />
          ),
        )
      ) : (
        <Pref title="종류별 용량" help="서버를 업데이트하면 볼 수 있어요." />
      )}
      <Pref
        title="기기 목록 캐시"
        help="서버 용량에는 들어가지 않는 이 기기의 추정치예요."
        control={
          <span className="un-pref-value">
            {cache.status === 'ready' ? bytes(cache.bytes) : cache.status === 'unavailable' ? '알 수 없음' : '확인 중'}
          </span>
        }
      />
      <Pref
        title="계산 방법"
        help={
          <>
            같은 파일은 한 번만 세요. DB·임시 파일·이전 버전은 빼요.
            {usage.unmeasuredAudioFiles ? ` 용량 기록이 없는 음성 ${usage.unmeasuredAudioFiles}개도 빠져 있어요.` : ''}
          </>
        }
      />
    </PrefFold>
  );
}

function DeviceEstimate() {
  const estimate = useDeviceStorageEstimate();
  return (
    <PrefSection
      title="이 브라우저"
      hint="기기 데이터와 캐시의 추정치예요. 서버 서재 용량은 들어가지 않아요."
      action={
        <button
          type="button"
          className="un-icon-btn is-sm"
          aria-label="브라우저 사용량 다시 확인"
          disabled={estimate.loading}
          onClick={() => void estimate.refresh()}
        >
          <RefreshCw size={15} />
        </button>
      }
    >
      <div className="un-storage-card">
        {estimate.unavailable ? (
          <p className="un-storage-muted">이 브라우저에서는 사용량을 볼 수 없어요.</p>
        ) : (
          <>
            <p>
              <strong>{estimate.loading ? '…' : bytes(estimate.usage)}</strong>
              <span> / {bytes(estimate.quota)}</span>
            </p>
            {estimate.ratio !== undefined && <Progress value={estimate.ratio / 100} label="브라우저 저장공간 사용률" />}
          </>
        )}
      </div>
    </PrefSection>
  );
}

function resultText(result: StorageBookMutationResult) {
  const label = ACTION_LABEL[result.action];
  const parts = [`${result.completed}개 ${label} 완료`];
  if (result.remaining) parts.push(`${result.remaining}개는 처리하지 못했어요. 목록을 확인하고 다시 골라 주세요.`);
  if (result.action === 'purge' && result.completed) parts.push('저장공간에 반영되기까지 조금 걸릴 수 있어요.');
  if (result.refreshFailed) parts.push('목록을 새로 고쳐 주세요.');
  return parts.join(' · ');
}

/** 작품별 관리: pick works by size and move them to the trash, restore or delete them for good. */
function ManageBooks({
  usage,
  management,
  refresh,
  initialTrash,
  onBack,
  onBusyChange,
}: {
  usage: LibraryStorageUsage;
  management?: StorageSettingsProps['management'];
  refresh(): Promise<void>;
  initialTrash: boolean;
  onBack(): void;
  onBusyChange?(busy: boolean): void;
}) {
  const [asking, setAsking] = useState<{ request: StorageBookConfirmation; answer(ok: boolean): void }>();
  const model = useStorageBookManagerModel({
    usage,
    management,
    refresh,
    initialTrash,
    onBusyChange,
    confirm: (request) => new Promise<boolean>((answer) => setAsking({ request, answer })),
  });
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = top.current?.closest('.un-settings-content');
    if (content) content.scrollTop = 0;
  }, []);
  const answer = (ok: boolean) => {
    asking?.answer(ok);
    setAsking(undefined);
  };
  const request = asking?.request;

  return (
    <div ref={top} className="un-storage-manage" aria-busy={model.busy}>
      <header className="un-storage-manage-head">
        <button type="button" className="un-btn is-text is-sm" disabled={model.busy} onClick={onBack}>
          <ChevronLeft size={18} />
          저장공간
        </button>
        <button
          type="button"
          className="un-icon-btn is-sm"
          aria-label="작품 용량 새로고침"
          disabled={model.busy}
          onClick={() => void model.refreshList()}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      <h3 className="un-storage-manage-title">작품별 관리</h3>

      <Segmented
        label="작품 위치"
        value={model.trash ? 'trash' : 'library'}
        options={[
          { value: 'library', label: `서재 ${model.locationCounts.library}` },
          { value: 'trash', label: `휴지통 ${model.locationCounts.trash}` },
        ]}
        onChange={(value) => !model.busy && model.changeLocation(value === 'trash')}
      />

      <div className="un-storage-tools">
        <label className="un-storage-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            className="un-input"
            placeholder="작품 검색"
            aria-label="작품 검색"
            value={model.query}
            disabled={model.busy}
            onChange={(event) => model.changeQuery(event.target.value)}
          />
        </label>
        <select
          className="un-select"
          aria-label="정렬"
          value={model.sort}
          disabled={model.busy}
          onChange={(event) => model.setSort(event.target.value as 'size' | 'name')}
        >
          <option value="size">큰 순</option>
          <option value="name">이름순</option>
        </select>
      </div>

      {management?.blocked && <Notice tone="warning">읽기·다운로드·가져오기를 마친 뒤 정리할 수 있어요.</Notice>}
      {model.result && !model.busy && <Notice>{resultText(model.result)}</Notice>}
      {model.trash && model.books.length > 0 && <Notice tone="warning">영구 삭제하면 되돌릴 수 없어요.</Notice>}

      {model.books.length ? (
        <ul className="un-storage-books">
          {model.visibleBooks.map((book) => {
            const checked = model.selected.has(book.id);
            return (
              <li key={book.id}>
                <label className={cx(checked && 'is-checked')}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={model.disabled}
                    onChange={(event) => model.select(book.id, event.target.checked)}
                  />
                  <span className="un-storage-check" aria-hidden="true" />
                  <span className="un-storage-book-title">{book.title}</span>
                  <span className="un-storage-book-size">{bytes(book.bytes)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon={model.trash ? <Trash2 size={22} /> : <BookOpen size={22} />}
          title={model.query ? '찾는 작품이 없어요' : model.trash ? '휴지통이 비어 있어요' : '저장된 작품이 없어요'}
        />
      )}
      {model.books.length > model.limit && (
        <button type="button" className="un-btn is-ghost un-storage-more" onClick={model.loadMore}>
          더 보기
        </button>
      )}

      {(model.targets.length > 0 || model.busy) && (
        <div className="un-storage-selection">
          <span>{model.busy ? '처리 중…' : `${model.targets.length}개 · ${bytes(model.selectedBytes)}`}</span>
          <button
            type="button"
            className="un-btn is-ghost is-sm"
            disabled={model.disabled || !model.targets.length}
            onClick={() => void model.mutate(model.trash ? 'restore' : 'moveToTrash')}
          >
            {model.trash ? '복원' : '휴지통으로'}
          </button>
          {model.trash && (
            <button
              type="button"
              className="un-btn is-sm is-danger"
              disabled={model.disabled || !model.targets.length}
              onClick={() => void model.mutate('purge')}
            >
              영구 삭제
            </button>
          )}
        </div>
      )}

      <Sheet
        open={Boolean(request)}
        variant="dialog"
        onClose={() => answer(false)}
        title={request ? ACTION_QUESTION[request.action] : undefined}
        footer={
          <>
            <button type="button" className="un-btn is-ghost" onClick={() => answer(false)}>
              취소
            </button>
            <button
              type="button"
              className={cx('un-btn', request?.action === 'purge' ? 'is-danger' : 'is-primary')}
              onClick={() => answer(true)}
            >
              {request ? ACTION_LABEL[request.action] : ''}
            </button>
          </>
        }
      >
        {request && (
          <div className="un-storage-confirm">
            <p>
              <b>{request.count}개 작품</b> · {request.titles.slice(0, 3).join(', ')}
              {request.count > 3 ? ` 외 ${request.count - 3}개` : ''}
            </p>
            {request.action === 'purge' && <Notice tone="danger">원본과 독서 기록이 지워지고 되돌릴 수 없어요.</Notice>}
            {request.action === 'moveToTrash' && <Notice>공간을 비우려면 휴지통에서 영구 삭제해야 해요.</Notice>}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** 저장공간: what the library takes, cleaning up downloads, backup, and the browser's own share. */
export function StoragePage({
  assets,
  management,
  hosted,
  controller,
  openBackup,
  onBusyChange,
}: StorageSettingsProps & {
  controller: ExternalSourceController;
  openBackup(): void;
  onBusyChange?(busy: boolean): void;
}) {
  const model = useStorageSettingsModel({ assets, controller });
  const { usage, retention } = model;

  if (model.managing && usage)
    return (
      <ManageBooks
        usage={usage}
        management={management}
        refresh={model.refresh}
        initialTrash={model.managing === 'trash'}
        onBack={() => model.setManaging(undefined)}
        onBusyChange={onBusyChange}
      />
    );

  const libraryShare = usage && usage.totalBytes ? usage.libraryBytes / usage.totalBytes : 0;

  return (
    <>
      <PrefSection
        title={hosted ? '서버 저장공간' : '이 기기의 작품 파일'}
        action={
          <button
            type="button"
            className="un-icon-btn is-sm"
            aria-label="사용량 새로고침"
            disabled={model.loading}
            onClick={() => void model.refresh()}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        {model.error === 'unsupported' ? (
          <Notice>이 환경에서는 작품별 용량을 볼 수 없어요.</Notice>
        ) : model.error === 'load_failed' ? (
          <Notice
            tone="danger"
            action={
              <button type="button" className="un-btn is-text is-sm" onClick={() => void model.refresh()}>
                다시 시도
              </button>
            }
          >
            사용량을 불러오지 못했어요.
          </Notice>
        ) : null}
        {model.loading && !usage && <PrefSkeleton rows={2} />}
        {usage && (
          <div className="un-storage-card">
            {hosted && <Capacity capacity={usage.capacity} />}
            <div className="un-storage-total">
              <span>{hosted ? 'BOAA가 쓰는 용량' : '작품 파일'}</span>
              <strong>{bytes(usage.totalBytes)}</strong>
            </div>
            <div className="un-storage-split" aria-hidden="true">
              <span style={{ width: `${libraryShare * 100}%` }} />
            </div>
            <dl className="un-storage-legend">
              <div>
                <dt>
                  <i />
                  서재 {model.libraryCount}개
                </dt>
                <dd>{bytes(usage.libraryBytes)}</dd>
              </div>
              <div>
                <dt>
                  <i className="is-trash" />
                  휴지통 {model.trashCount}개
                </dt>
                <dd>{bytes(usage.trashBytes)}</dd>
              </div>
            </dl>
          </div>
        )}
        {usage && (
          <PrefGroup>
            <PrefLink
              icon={<Library size={17} />}
              title="작품별 관리"
              help="큰 작품부터 골라 휴지통으로 옮겨요."
              onClick={() => model.setManaging('library')}
            />
            <PrefLink
              icon={<Trash2 size={17} />}
              title="휴지통"
              value={`${model.trashCount}개`}
              onClick={() => model.setManaging('trash')}
            />
          </PrefGroup>
        )}
        {usage && <UsageDetails usage={usage} />}
      </PrefSection>

      {retention && (
        <PrefSection title="받은 회차 정리" hint="원본 파일, 즐겨찾기, 아직 안 읽은 회차는 남겨요.">
          <PrefGroup>
            <Pref
              title={
                retention.preview
                  ? retention.preview.length
                    ? `${retention.preview.length}개 작품 · ${model.cleanupSectionCount}회 정리할 수 있어요`
                    : '지금 정리할 회차가 없어요'
                  : '정리할 회차 찾기'
              }
              help={retention.busy ? '정리 중…' : retention.readerActive ? '읽는 중에는 정리할 수 없어요.' : undefined}
              control={
                retention.preview?.length ? (
                  <button
                    type="button"
                    className="un-btn is-primary is-sm"
                    disabled={retention.busy || controller.busy || management?.blocked || retention.readerActive}
                    onClick={() => void model.clean()}
                  >
                    정리하기
                  </button>
                ) : (
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    disabled={retention.busy || controller.busy || management?.blocked}
                    onClick={() => void retention.inspect()}
                  >
                    {retention.preview ? '다시 찾기' : '찾기'}
                  </button>
                )
              }
            />
          </PrefGroup>
          {Boolean(retention.preview?.length) && (
            <PrefFold title="정리할 작품" summary={`${retention.preview?.length}개`}>
              {retention.preview?.map((item) => (
                <Pref
                  key={item.bookId}
                  title={item.title}
                  control={<span className="un-pref-value">{item.sections.length}회</span>}
                />
              ))}
            </PrefFold>
          )}
          {retention.error && <Notice tone="danger">{retention.error}</Notice>}
        </PrefSection>
      )}

      <PrefGroup>
        <PrefLink
          icon={<ArchiveRestore size={17} />}
          title="백업과 복원"
          help="서재와 독서 기록을 파일로 보관해요."
          onClick={openBackup}
        />
      </PrefGroup>

      <DeviceEstimate />
    </>
  );
}
