import { lazy, type ComponentType } from 'react';
import type { ReaderSettingsPanelProps } from '../features/reader-settings/settings-panel-contract';

// App already lazy-loads this module, so export a plain component that picks the panel once.
const Panel = lazy<ComponentType<ReaderSettingsPanelProps>>(() => import('./settings/UiNextSettingsPanel'));

export default function SettingsPanel(props: ReaderSettingsPanelProps) {
  return <Panel {...props} />;
}
