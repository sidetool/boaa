import { createStartupScreenSettingsModel } from './startup-screen-settings-model';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

export function StartupScreenSettings({
  controller,
  shelves = [],
  tabs = [],
}: {
  controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  shelves?: readonly { id: string; name: string }[];
  tabs?: readonly { id: string; title: string; hidden?: boolean }[];
}) {
  const model = createStartupScreenSettingsModel({ controller, shelves, tabs });
  const { value, missing, select } = model;
  const options = model.options.map((option) => ({
    ...option,
    label:
      option.kind === 'default'
        ? '기본 · 홈'
        : option.kind === 'home'
          ? '홈'
          : option.kind === 'library'
            ? '라이브러리 · 전체'
            : option.kind === 'shelf'
              ? `라이브러리 · ${option.name}`
              : option.kind === 'discovery'
                ? '탐색 · 첫 탭'
                : `탐색 · ${option.name}`,
  }));
  return (
    <section className="reader-settings-group">
      <h3>시작 화면</h3>
      <label className="reader-settings-select-row startup-screen-select">
        <span>앱을 열면</span>
        <select aria-label="시작 화면" value={value} onChange={(event) => select(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {missing && <option value={value}>이전에 선택한 화면 · 현재 사용할 수 없음</option>}
        </select>
      </label>
      <p className="muted">
        다음에 앱을 열 때 적용됩니다.{missing ? ' 책장이 없으면 전체로, 탐색 탭이 없으면 첫 탭으로 열립니다.' : ''}
      </p>
    </section>
  );
}
