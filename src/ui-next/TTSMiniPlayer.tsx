import { lazy, type ComponentType } from 'react';
import type { TTSCompactBarProps } from '../features/tts/tts-compact-contract';

// App already lazy-loads this module, so export a plain component that picks the player once.
const Player = lazy<ComponentType<TTSCompactBarProps>>(() => import('./reader/UiNextMiniPlayer'));

export default function TTSMiniPlayer(props: TTSCompactBarProps) {
  return <Player {...props} />;
}
