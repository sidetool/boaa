import { lazy, type ComponentType } from 'react';
import type { TTSAddonPanelProps } from '../features/tts/TTSAddonPanel';

// App already lazy-loads this module, so export a plain component that picks the panel once.
const Panel = lazy<ComponentType<TTSAddonPanelProps>>(() => import('./reader/UiNextListenPanel'));

export default function TTSPanel(props: TTSAddonPanelProps) {
  return <Panel {...props} />;
}
