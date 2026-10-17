import { lazy, type ComponentType } from 'react';
import type { ReaderOutlinePanelProps } from '../features/annotations/reader-outline-contract';

// App already lazy-loads this module, so export a plain component that picks the panel once.
const Panel = lazy<ComponentType<ReaderOutlinePanelProps>>(() => import('./reader/UiNextOutlinePanel'));

export default function OutlinePanel(props: ReaderOutlinePanelProps) {
  return <Panel {...props} />;
}
