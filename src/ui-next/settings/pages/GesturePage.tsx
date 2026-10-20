import type { GestureBindings, ReaderAction } from '../../../domain/types';
import { useReaderDeviceControls } from '../../../features/reader-settings/use-reader-device-controls';
import { Segmented } from '../../components/primitives';
import { Pref, PrefGroup, PrefSection, PrefSwitch } from '../../components/prefs';

const ACTIONS: readonly { value: ReaderAction; label: string; short: string }[] = [
  { value: 'previous_page', label: '이전 페이지', short: '이전' },
  { value: 'next_page', label: '다음 페이지', short: '다음' },
  { value: 'toggle_chrome', label: '메뉴 보이기·숨기기', short: '메뉴' },
  { value: 'open_toc', label: '목차 열기', short: '목차' },
  { value: 'open_settings', label: '설정 열기', short: '설정' },
  { value: 'toggle_tts', label: '듣기 재생·멈춤', short: '듣기' },
  { value: 'none', label: '사용 안 함', short: '없음' },
];

const short = (action: ReaderAction | undefined) => ACTIONS.find((item) => item.value === (action ?? 'none'))?.short;

function ActionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReaderAction | undefined;
  onChange(value: ReaderAction): void;
}) {
  return (
    <select
      className="un-select"
      aria-label={label}
      value={value ?? 'none'}
      onChange={(event) => onChange(event.target.value as ReaderAction)}
    >
      {ACTIONS.map((action) => (
        <option key={action.value} value={action.value}>
          {action.label}
        </option>
      ))}
    </select>
  );
}

const TAPS: readonly { key: keyof GestureBindings; title: string }[] = [
  { key: 'tapLeft', title: '왼쪽' },
  { key: 'tapCenter', title: '가운데' },
  { key: 'tapRight', title: '오른쪽' },
];

const SWIPES: readonly { key: keyof GestureBindings; title: string }[] = [
  { key: 'swipeLeft', title: '왼쪽으로 밀기' },
  { key: 'swipeRight', title: '오른쪽으로 밀기' },
];

/** 리더 조작: what taps and swipes do while reading, and keeping the screen awake or upright. */
export function GesturePage({
  bindings,
  update,
}: {
  bindings: GestureBindings;
  update(patch: Partial<GestureBindings>): void;
}) {
  const device = useReaderDeviceControls();
  return (
    <>
      <PrefSection title="화면 누르기" hint="읽는 화면을 세 부분으로 나눠서 눌렀을 때 할 일을 정해요.">
        <div className="un-gesture-map" aria-hidden="true">
          {TAPS.map((tap) => (
            <span key={tap.key}>{short(bindings[tap.key])}</span>
          ))}
        </div>
        <PrefGroup>
          {TAPS.map((tap) => (
            <Pref
              key={tap.key}
              title={`${tap.title} 누르기`}
              control={
                <ActionSelect
                  label={`${tap.title} 누르기`}
                  value={bindings[tap.key]}
                  onChange={(value) => update({ [tap.key]: value })}
                />
              }
            />
          ))}
        </PrefGroup>
      </PrefSection>

      <PrefSection title="밀기">
        <PrefGroup>
          {SWIPES.map((swipe) => (
            <Pref
              key={swipe.key}
              title={swipe.title}
              control={
                <ActionSelect
                  label={swipe.title}
                  value={bindings[swipe.key]}
                  onChange={(value) => update({ [swipe.key]: value })}
                />
              }
            />
          ))}
        </PrefGroup>
      </PrefSection>

      {(device.wakeLockAvailable || device.orientationAvailable) && (
        <PrefSection title="화면" hint="이 기기에 저장하고, 다음에 읽을 때도 적용해요.">
          <PrefGroup>
            {device.wakeLockAvailable && (
              <PrefSwitch
                title="화면 계속 켜 두기"
                checked={device.wakeLocked}
                onChange={() => void device.toggleWakeLock()}
              />
            )}
            {device.orientationAvailable && (
              <Pref
                title="화면 방향"
                control={
                  <Segmented
                    label="화면 방향"
                    value={device.orientation ?? 'auto'}
                    options={[
                      { value: 'auto', label: '자동' },
                      { value: 'portrait', label: '세로' },
                      { value: 'landscape', label: '가로' },
                    ]}
                    onChange={(value) => void device.setOrientationLock(value === 'auto' ? undefined : value)}
                  />
                }
              />
            )}
          </PrefGroup>
        </PrefSection>
      )}
    </>
  );
}
