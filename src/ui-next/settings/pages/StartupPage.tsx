import { Compass, House, Library } from 'lucide-react';
import type { ReactNode } from 'react';
import { createStartupScreenSettingsModel } from '../../../features/reader-settings/startup-screen-settings-model';
import type { StartupScreenOption } from '../../../features/reader-settings/startup-screen-settings-model';
import type { ReaderSettingsController } from '../../../features/reader-settings/useReaderSettingsDraft';
import { Notice, PrefOptions, PrefSection } from '../../components/prefs';

function label(option: StartupScreenOption) {
  switch (option.kind) {
    case 'default':
      return '기본값';
    case 'home':
      return '홈';
    case 'library':
      return '전체';
    case 'discovery':
      return '첫 탭';
    default:
      return option.name ?? '';
  }
}

const GROUPS: readonly { title: string; icon: ReactNode; kinds: readonly StartupScreenOption['kind'][] }[] = [
  { title: '홈', icon: <House size={16} />, kinds: ['default', 'home'] },
  { title: '서재', icon: <Library size={16} />, kinds: ['library', 'shelf'] },
  { title: '탐색', icon: <Compass size={16} />, kinds: ['discovery', 'tab'] },
];

/** 모양 › 시작 화면: where the app opens. Shelves and discovery tabs join the list as they exist. */
export function StartupPage({
  controller,
  shelves,
  tabs,
}: {
  controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  shelves?: readonly { id: string; name: string }[];
  tabs?: readonly { id: string; title: string; hidden?: boolean }[];
}) {
  const model = createStartupScreenSettingsModel({ controller, shelves, tabs });
  return (
    <PrefSection title="시작 화면" hint="앱을 열 때 처음 보이는 화면이에요. 다음에 열 때부터 적용돼요.">
      {model.missing && (
        <Notice tone="warning">
          고른 화면을 지금은 쓸 수 없어요. 책장이 없으면 서재 전체로, 탐색 탭이 없으면 첫 탭으로 열려요.
        </Notice>
      )}
      {GROUPS.map((group) => {
        const options = model.options.filter((option) => group.kinds.includes(option.kind));
        if (!options.length) return null;
        return (
          <div key={group.title} className="un-startup-group">
            <h4>
              {group.icon}
              {group.title}
            </h4>
            <PrefOptions
              label={`시작 화면 · ${group.title}`}
              value={model.value}
              options={options.map((option) => ({
                value: option.value,
                label: label(option),
                hint: option.kind === 'default' ? '따로 고르지 않으면 홈에서 시작해요' : undefined,
              }))}
              onChange={model.select}
            />
          </div>
        );
      })}
    </PrefSection>
  );
}
