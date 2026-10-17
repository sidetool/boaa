import { Lock, MonitorUp, Unlock } from 'lucide-react';
import { useReaderDeviceControls } from './use-reader-device-controls';

export function ReaderDeviceControls() {
  const { wakeLockAvailable, orientationAvailable, wakeLocked, orientation, toggleWakeLock, setOrientationLock } =
    useReaderDeviceControls();
  if (!wakeLockAvailable && !orientationAvailable) return null;

  return (
    <section className="reader-settings-group reader-device-settings">
      <h3>화면 유지</h3>
      <div className="reader-device-controls">
        {wakeLockAvailable && (
          <button
            type="button"
            className={`ghost-btn${wakeLocked ? ' active' : ''}`}
            onClick={() => void toggleWakeLock()}
          >
            {wakeLocked ? <Lock size={16} /> : <Unlock size={16} />} 화면 항상 켜기
          </button>
        )}
        {orientationAvailable && (
          <label>
            <MonitorUp size={16} />
            <select
              value={orientation ?? ''}
              onChange={(event) =>
                void setOrientationLock((event.target.value || undefined) as 'portrait' | 'landscape' | undefined)
              }
            >
              <option value="">회전 자동</option>
              <option value="portrait">세로 고정</option>
              <option value="landscape">가로 고정</option>
            </select>
          </label>
        )}
      </div>
    </section>
  );
}
