import { useDeviceStorageEstimate } from './use-device-storage-estimate';
import { RefreshCw } from 'lucide-react';

export function formatStorageBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

export function DeviceStorageEstimate() {
  const estimate = useDeviceStorageEstimate();
  const { ratio, refresh } = estimate;
  return (
    <div className="download-storage-estimate" aria-live="polite">
      <div>
        <strong>이 브라우저의 사이트 저장공간</strong>
        <span>
          {estimate.loading
            ? '확인 중…'
            : estimate.unavailable
              ? '이 브라우저에서는 사용량을 확인할 수 없습니다.'
              : `${formatStorageBytes(estimate.usage)} / ${formatStorageBytes(estimate.quota)}`}
        </span>
      </div>
      {ratio !== undefined && (
        <div
          className="download-storage-meter"
          role="meter"
          aria-label="브라우저 저장공간 사용률"
          aria-valuenow={ratio}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${ratio}%` }} />
        </div>
      )}
      <button type="button" className="ghost-btn" onClick={() => void refresh()} disabled={estimate.loading}>
        <RefreshCw size={15} aria-hidden="true" />
        다시 확인
      </button>
      <small>기기 데이터와 캐시의 추정치입니다. 서버 책장 용량은 포함하지 않습니다.</small>
    </div>
  );
}
